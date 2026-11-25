using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

[assembly: AssemblyTitle("SuperAgent Link")]

namespace SuperAgentLinkTray
{
    internal static class NativeMethods
    {
        public const uint ES_CONTINUOUS = 0x80000000;
        public const uint ES_SYSTEM_REQUIRED = 0x00000001;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint esFlags);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicJobLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobIoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedJobLimits
        {
            public BasicJobLimits BasicLimits;
            public JobIoCounters IoCounters;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, int classId, ref ExtendedJobLimits limits, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

        public static SafeFileHandle OwnProcessTree(Process process)
        {
            const int jobObjectExtendedLimitInformation = 9;
            const uint jobObjectLimitKillOnJobClose = 0x00002000;
            var job = CreateJobObject(IntPtr.Zero, null);
            var limits = new ExtendedJobLimits { BasicLimits = new BasicJobLimits { LimitFlags = jobObjectLimitKillOnJobClose } };
            if (job.IsInvalid
                || !SetInformationJobObject(job, jobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedJobLimits)))
                || !AssignProcessToJobObject(job, process.Handle))
            {
                var error = new Win32Exception(Marshal.GetLastWin32Error());
                job.Dispose();
                throw error;
            }
            return job;
        }
    }

    internal enum LinkStatus
    {
        Unpaired,
        Reconnecting,
        Connected,
        Revoked
    }

    internal sealed class TrayApp : ApplicationContext
    {
        internal static readonly string AppVersion = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
        // The rolling link-latest release always holds the newest Link, whatever else the repository releases.
        private const string ReleasesApiUrl = "https://api.github.com/repos/robinAKL/superagent/releases/tags/link-latest";
        private const string InstallerName = "SuperAgentLink-Setup-x64.exe";

        private readonly string _installDir;
        private readonly string _dataDir;
        private readonly string _tokenPath;
        private readonly string _logPath;
        private readonly string _nodeExe;
        private readonly string _linkEntry;
        private string _serverUrl;

        private readonly NotifyIcon _tray;
        private readonly ToolStripMenuItem _statusItem;
        private readonly object _logLock = new object();
        private readonly WindowsFormsSynchronizationContext _uiContext = new WindowsFormsSynchronizationContext();
        private readonly System.Threading.Timer _updateTimer;
        private readonly System.Windows.Forms.Timer _restartTimer = new System.Windows.Forms.Timer();

        private Process _child;
        private SafeFileHandle _childJob;
        private volatile bool _exiting;
        private bool _taskActive;
        /** A newer Link found on link-latest, waiting for the person to click 升级. */
        private UpdateOffer _offer;
        private string _notifiedVersion;
        private bool _updating;
        private bool _updateAfterTask;
        private Action _balloonClick;
        private ToolStripMenuItem _updateItem;
        private ToolStripMenuItem _checkUpdateItem;
        private ToolStripMenuItem _modeMenu;
        private LinkStatus _status = LinkStatus.Unpaired;
        private int _restartAttempt;
        private Icon _currentIcon;
        // An agent CLI whose sign-in expired: the tray opens its login and restarts Link so the task retries.
        private readonly ToolStripMenuItem _signInItem;
        private string _authAgent;
        private bool _reauthRunning;
        private bool _restartAfterTask;
        // The local clients window: open at most once at a time; offered once after this computer first connects.
        private bool _clientsOpen;
        private bool _clientsPrompted;

        public TrayApp()
        {
            _installDir = AppDomain.CurrentDomain.BaseDirectory;
            _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SuperAgentLink");
            Directory.CreateDirectory(_dataDir);
            var appDataDir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            _tokenPath = Path.Combine(appDataDir, "SuperAgent", "link.token");
            var logDir = Path.Combine(_dataDir, "logs");
            Directory.CreateDirectory(logDir);
            _logPath = Path.Combine(logDir, "link.log");
            using (var proc = Process.GetCurrentProcess()) Log("Started tray process pid=" + proc.Id);

            _nodeExe = Path.Combine(_installDir, "runtime", "node.exe");
            _linkEntry = Path.Combine(_installDir, "app", "link", "start.mjs");
            _serverUrl = Environment.GetEnvironmentVariable("SUPERAGENT_ORIGIN") ?? ReadConfiguredServerUrl();
            if (string.IsNullOrEmpty(_serverUrl))
            {
                _serverUrl = PromptServerUrl("https://");
                if (!string.IsNullOrEmpty(_serverUrl)) SaveConfiguredServerUrl(_serverUrl);
            }

            _statusItem = new ToolStripMenuItem("Status: Unpaired") { Enabled = false };
            var openRoomItem = new ToolStripMenuItem("Open Command Room / 打开指挥室", null, OnOpenRoom);
            var configureItem = new ToolStripMenuItem("Local clients / 本地客户端（Claude Code、Codex）", null, OnConfigureAgent);
            var repairItem = new ToolStripMenuItem("Re-pair / 重新配对", null, OnRepair);
            var logsItem = new ToolStripMenuItem("View Logs / 查看日志", null, OnViewLogs);
            var exitItem = new ToolStripMenuItem("Exit / 退出", null, OnExit);
            _signInItem = new ToolStripMenuItem("Sign in again / 重新登录", null, (s, e) => BeginReauth(_authAgent)) { Visible = false };

            _updateItem = new ToolStripMenuItem("Update / 升级", null, (s, e) => BeginUpdate()) { Visible = false };
            _checkUpdateItem = new ToolStripMenuItem("Check for updates / 检查更新", null, (s, e) => CheckForUpdatesInBackground(true));
            var versionItem = new ToolStripMenuItem("Version / 版本 " + AppVersion) { Enabled = false };
            _modeMenu = new ToolStripMenuItem("Authorisation / 授权模式");
            foreach (var mode in new[] { "strict", "standard", "full" })
            {
                var name = mode;
                var item = new ToolStripMenuItem(ModeLabel(name), null, (s, e) => SetPermissionMode(name)) { Tag = name };
                _modeMenu.DropDownItems.Add(item);
            }
            _modeMenu.DropDownOpening += (s, e) => RefreshPermissionMode();

            var menu = new ContextMenuStrip();
            menu.Items.Add(_statusItem);
            menu.Items.Add(_signInItem);
            menu.Items.Add(_updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openRoomItem);
            menu.Items.Add(configureItem);
            menu.Items.Add(repairItem);
            menu.Items.Add(logsItem);
            menu.Items.Add(_modeMenu);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(versionItem);
            menu.Items.Add(_checkUpdateItem);
            menu.Items.Add(exitItem);

            _tray = new NotifyIcon
            {
                ContextMenuStrip = menu,
                Visible = true
            };
            _tray.DoubleClick += OnOpenRoom;
            UpdateStatus(LinkStatus.Unpaired);

            _restartTimer.Tick += (s, e) =>
            {
                _restartTimer.Stop();
                StartLinkProcess(pairMode: false);
            };

            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            AppDomain.CurrentDomain.ProcessExit += (s, e) => Cleanup();

            StartLinkProcess(pairMode: false);
            _tray.BalloonTipClicked += (s, e) => { var click = _balloonClick; _balloonClick = null; if (click != null) click(); };
            _tray.BalloonTipClosed += (s, e) => { _balloonClick = null; };
            _updateTimer = new System.Threading.Timer(_ => CheckForUpdatesSafe(false), null, TimeSpan.FromSeconds(15), TimeSpan.FromHours(6));
        }

        private string ReadConfiguredServerUrl()
        {
            try
            {
                var cfgPath = Path.Combine(_dataDir, "config.json");
                if (!File.Exists(cfgPath)) return null;
                var text = File.ReadAllText(cfgPath, Encoding.UTF8);
                var m = Regex.Match(text, "\"serverUrl\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
            catch { return null; }
        }

        private void SaveConfiguredServerUrl(string url)
        {
            try
            {
                var cfgPath = Path.Combine(_dataDir, "config.json");
                var escaped = url.Replace("\\", "\\\\").Replace("\"", "\\\"");
                File.WriteAllText(cfgPath, "{\"serverUrl\":\"" + escaped + "\"}\r\n", Encoding.UTF8);
            }
            catch { }
        }

        private static string PromptServerUrl(string defaultValue)
        {
            using (var form = new Form())
            using (var label = new Label())
            using (var box = new TextBox())
            using (var ok = new Button())
            using (var cancel = new Button())
            {
                form.Text = "SuperAgent Link - Server URL";
                form.Width = 420;
                form.Height = 160;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.MaximizeBox = false;
                form.MinimizeBox = false;

                label.Text = "SuperAgent Server URL (e.g. https://your-host):";
                label.SetBounds(16, 14, 370, 20);

                box.Text = defaultValue ?? string.Empty;
                box.SetBounds(16, 38, 370, 24);

                ok.Text = "OK";
                ok.DialogResult = DialogResult.OK;
                ok.SetBounds(224, 78, 76, 28);

                cancel.Text = "Cancel";
                cancel.DialogResult = DialogResult.Cancel;
                cancel.SetBounds(310, 78, 76, 28);

                form.AcceptButton = ok;
                form.CancelButton = cancel;
                form.Controls.AddRange(new Control[] { label, box, ok, cancel });

                if (form.ShowDialog() == DialogResult.OK)
                {
                    var val = (box.Text ?? string.Empty).Trim().TrimEnd('/');
                    if (val.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || val.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        return val;
                }
                return null;
            }
        }

        private void Log(string line)
        {
            try
            {
                lock (_logLock)
                {
                    if (File.Exists(_logPath) && new FileInfo(_logPath).Length > 5 * 1024 * 1024)
                    {
                        var backup = _logPath + ".1";
                        if (File.Exists(backup)) File.Delete(backup);
                        File.Move(_logPath, backup);
                    }
                    File.AppendAllText(_logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { /* never crash tray on log IO */ }
        }

        private void UpdateStatus(LinkStatus next)
        {
            _status = next;
            string label;
            Color color;
            switch (next)
            {
                case LinkStatus.Connected:
                    label = "已连接 / Connected";
                    color = Color.FromArgb(34, 197, 94);
                    break;
                case LinkStatus.Reconnecting:
                    label = "重连中 / Reconnecting";
                    color = Color.FromArgb(245, 158, 11);
                    break;
                case LinkStatus.Revoked:
                    label = "已吊销 / Revoked";
                    color = Color.FromArgb(239, 68, 68);
                    break;
                default:
                    label = "未配对 / Unpaired";
                    color = Color.FromArgb(148, 163, 184);
                    break;
            }

            _statusItem.Text = "状态: " + label;
            _tray.Text = "SuperAgent Link - " + label;
            var prev = _currentIcon;
            _currentIcon = BuildStatusIcon(color);
            _tray.Icon = _currentIcon;
            if (prev != null) prev.Dispose();
        }

        private static Icon BuildStatusIcon(Color badgeColor)
        {
            using (var bmp = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var bg = new SolidBrush(Color.FromArgb(24, 24, 27)))
                    g.FillEllipse(bg, 2, 2, 28, 28);
                using (var pen = new Pen(badgeColor, 2.5f))
                    g.DrawEllipse(pen, 3, 3, 26, 26);
                using (var dot = new SolidBrush(badgeColor))
                    g.FillEllipse(dot, 10, 10, 12, 12);

                IntPtr hIcon = bmp.GetHicon();
                try
                {
                    using (var tmp = Icon.FromHandle(hIcon))
                        return (Icon)tmp.Clone();
                }
                finally
                {
                    NativeMethods.DestroyIcon(hIcon);
                }
            }
        }

        private void SetTaskSleepInhibition(bool active)
        {
            _taskActive = active;
            if (!active && _updateAfterTask)
            {
                _updateAfterTask = false;
                _uiContext.Post(_ => BeginUpdate(), null);
            }
            NativeMethods.SetThreadExecutionState(active
                ? NativeMethods.ES_CONTINUOUS | NativeMethods.ES_SYSTEM_REQUIRED
                : NativeMethods.ES_CONTINUOUS);
        }

        private void StartLinkProcess(bool pairMode)
        {
            if (_exiting) return;
            _restartTimer.Stop();
            if (!File.Exists(_nodeExe) || !File.Exists(_linkEntry))
            {
                Log("Missing bundled runtime or link entrypoint: " + _nodeExe + " | " + _linkEntry);
                UpdateStatus(LinkStatus.Unpaired);
                return;
            }

            if (string.IsNullOrEmpty(_serverUrl))
            {
                Log("No SUPERAGENT_ORIGIN configured; waiting for Re-pair.");
                UpdateStatus(LinkStatus.Unpaired);
                return;
            }

            StopChild();
            var psi = new ProcessStartInfo
            {
                FileName = _nodeExe,
                Arguments = "\"" + _linkEntry + "\"",
                WorkingDirectory = _dataDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.EnvironmentVariables["SUPERAGENT_ORIGIN"] = _serverUrl;
            psi.EnvironmentVariables["SUPERAGENT_LINK_DATA_DIR"] = _dataDir;

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (s, e) =>
            {
                if (e.Data != null)
                    _uiContext.Post(_ => { if (_child == proc && !_exiting) HandleLinkLine(e.Data); }, null);
            };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("[stderr] " + e.Data); };
            proc.Exited += (s, e) => _uiContext.Post(_ => OnChildExited(proc), null);

            _child = proc;
            try
            {
                proc.Start();
                _childJob = NativeMethods.OwnProcessTree(proc);
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                UpdateStatus(File.Exists(_tokenPath) ? LinkStatus.Reconnecting : LinkStatus.Unpaired);
                Log("Started link process pid=" + proc.Id + " origin=" + _serverUrl + (pairMode ? " (re-pair)" : ""));
            }
            catch (Exception ex)
            {
                StopChild();
                Log("Could not start Link: " + ex.Message);
                ScheduleReconnect();
            }
        }

        private void HandleLinkLine(string line)
        {
            Log(line);
            if (line.StartsWith("LINK_STATE:", StringComparison.Ordinal))
            {
                var s = line.Substring("LINK_STATE:".Length).Trim().ToLowerInvariant();
                if (s == "connected") { _restartAttempt = 0; UpdateStatus(LinkStatus.Connected); MaybeGuideClients(); }
                else if (s == "reconnecting") UpdateStatus(LinkStatus.Reconnecting);
                else if (s == "revoked") UpdateStatus(LinkStatus.Revoked);
                else if (s == "unpaired") UpdateStatus(LinkStatus.Unpaired);
            }
            else if (line == "LINK_TASK:start")
            {
                SetTaskSleepInhibition(true);
            }
            else if (line == "LINK_TASK:end")
            {
                SetTaskSleepInhibition(false);
                if (_restartAfterTask)
                {
                    _restartAfterTask = false;
                    StartLinkProcess(pairMode: false);
                }
            }
            else if (line.StartsWith("LINK_AUTH:", StringComparison.Ordinal))
            {
                BeginReauth(line.Substring("LINK_AUTH:".Length).Trim());
            }
            else if (line.StartsWith("LINK_CLIENT_SETUP:", StringComparison.Ordinal))
            {
                // Asked from the web page: open the local clients window and start that step (install, sign in, connect).
                var parts = line.Substring("LINK_CLIENT_SETUP:".Length).Trim().Split(':');
                if (parts.Length == 2) { var ignored = ShowClients(parts[0], parts[1]); }
            }
            else if (line.StartsWith("LINK_MCP_LOGIN:", StringComparison.Ordinal))
            {
                OpenMcpLogin(line.Substring("LINK_MCP_LOGIN:".Length).Trim());
            }
        }

        private static string AgentLabel(string agent)
        {
            return agent == "codex" ? "Codex" : agent == "claude-code" ? "Claude Code" : agent;
        }

        /** The CLI's own sign-in command, the same one Set up local agent uses. */
        private static string LoginArguments(string agent)
        {
            return agent == "codex" ? "login" : agent == "claude-code" ? "auth login" : null;
        }

        /** The executable a configured project uses for this agent; paths stay on this computer. */
        private string AgentExecutable(string agent)
        {
            try
            {
                var path = Path.Combine(_dataDir, "link-runtime.json");
                if (!File.Exists(path)) return null;
                var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                object raw;
                var projects = config != null && config.TryGetValue("projects", out raw) ? raw as Dictionary<string, object> : null;
                if (projects == null) return null;
                foreach (var entry in projects.Values)
                {
                    var project = entry as Dictionary<string, object>;
                    object configuredAgent, executable;
                    if (project != null && project.TryGetValue("agent", out configuredAgent) && agent.Equals(configuredAgent)
                        && project.TryGetValue("executable", out executable) && executable is string)
                        return (string)executable;
                }
            }
            catch (Exception ex) { Log("Could not read link-runtime.json: " + ex.Message); }
            return null;
        }

        /** The folder of the first project that uses this agent: project-scoped MCP servers are found from there. */
        private string AgentDirectory(string agent)
        {
            try
            {
                var path = Path.Combine(_dataDir, "link-runtime.json");
                if (!File.Exists(path)) return null;
                var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                object raw;
                var projects = config != null && config.TryGetValue("projects", out raw) ? raw as Dictionary<string, object> : null;
                if (projects == null) return null;
                foreach (var entry in projects.Values)
                {
                    var project = entry as Dictionary<string, object>;
                    object configuredAgent, directory;
                    if (project != null && project.TryGetValue("agent", out configuredAgent) && agent.Equals(configuredAgent)
                        && project.TryGetValue("directory", out directory) && directory is string && Directory.Exists((string)directory))
                        return (string)directory;
                }
            }
            catch (Exception ex) { Log("Could not read link-runtime.json: " + ex.Message); }
            return null;
        }

        /**
         * The command room asked to sign an MCP server in again. Open Claude Code's MCP list in a window on this
         * computer; the person picks the server and signs in in their browser. Accounts and passwords are theirs alone.
         */
        private void OpenMcpLogin(string server)
        {
            if (_exiting || string.IsNullOrEmpty(server)) return;
            var executable = AgentExecutable("claude-code");
            if (string.IsNullOrEmpty(executable) || !File.Exists(executable))
            {
                Notify(server + " 需要重新登录", "没有找到 Claude Code。请在托盘菜单选择「配置本地 Agent」。", ToolTipIcon.Warning);
                return;
            }
            try
            {
                var start = new ProcessStartInfo { UseShellExecute = true };
                if (executable.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
                {
                    start.FileName = _nodeExe;
                    start.Arguments = "\"" + executable + "\" /mcp";
                }
                else
                {
                    start.FileName = executable;
                    start.Arguments = "/mcp";
                }
                var directory = AgentDirectory("claude-code");
                if (directory != null) start.WorkingDirectory = directory;
                Process.Start(start);
                Log("Opened the MCP sign-in for " + server + ".");
                Notify("请登录 " + server, "已打开 Claude Code 的连接列表：用上下键选中 " + server + "，按回车，选 Authenticate，再在浏览器里登录并同意。", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                Log("Could not open the MCP sign-in: " + ex.Message);
                Notify(server + " 需要重新登录", "没能自动打开登录窗口。请回到指挥室，按提示操作。", ToolTipIcon.Warning);
            }
        }

        private void Notify(string title, string text, ToolTipIcon icon)
        {
            try { _tray.ShowBalloonTip(10000, title, text, icon); } catch { }
        }

        /**
         * A task failed because the agent CLI is signed out (e.g. an expired Claude Code session). Open that CLI's own
         * sign-in for the person at the computer; when it succeeds, restart Link, which re-queues the waiting task.
         */
        private async void BeginReauth(string agent)
        {
            var args = LoginArguments(agent);
            if (_reauthRunning || _exiting || args == null) return;
            var label = AgentLabel(agent);
            _authAgent = agent;
            _signInItem.Text = "Sign in to " + label + " again / 重新登录 " + label;
            _signInItem.Visible = true;
            var executable = AgentExecutable(agent);
            if (string.IsNullOrEmpty(executable) || !File.Exists(executable))
            {
                Notify(label + " 需要重新登录", "没有找到 " + label + " 命令行。请在托盘菜单选择「配置本地 Agent」。", ToolTipIcon.Warning);
                return;
            }
            _reauthRunning = true;
            try
            {
                Notify(label + " 登录已过期", "已为你打开 " + label + " 登录。请在弹出的窗口或浏览器里完成登录，之后任务会自动重试。", ToolTipIcon.Warning);
                Log("Opening " + label + " sign-in after an authentication failure.");
                var start = new ProcessStartInfo { UseShellExecute = true };
                if (executable.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
                {
                    start.FileName = _nodeExe;
                    start.Arguments = "\"" + executable + "\" " + args;
                }
                else
                {
                    start.FileName = executable;
                    start.Arguments = args;
                }
                int code;
                using (var login = Process.Start(start))
                {
                    if (login == null) throw new InvalidOperationException("the sign-in did not start");
                    var finished = await Task.Run(() => login.WaitForExit(15 * 60 * 1000));
                    if (!finished)
                    {
                        try { login.Kill(); } catch { }
                        code = -1;
                    }
                    else code = login.ExitCode;
                }
                if (code != 0)
                {
                    Log(label + " sign-in ended with code " + code + ".");
                    Notify(label + " 登录未完成", "在托盘菜单点「重新登录 " + label + "」再试一次。", ToolTipIcon.Warning);
                    return;
                }
                Log(label + " sign-in finished; restarting Link to retry waiting tasks.");
                _signInItem.Visible = false;
                Notify(label + " 已重新登录", "正在重试等待中的任务。", ToolTipIcon.Info);
                // Do not cut off another task that is running right now; restart when it ends.
                if (_taskActive) _restartAfterTask = true;
                else if (!_exiting) StartLinkProcess(pairMode: false);
            }
            catch (Exception ex)
            {
                Log("Could not open " + label + " sign-in: " + ex.Message);
                Notify(label + " 需要重新登录", "无法自动打开登录。请在托盘菜单点「重新登录 " + label + "」。", ToolTipIcon.Warning);
            }
            finally
            {
                _reauthRunning = false;
            }
        }

        private void OnChildExited(Process exited)
        {
            if (_exiting || _child != exited) return;
            int code = exited.ExitCode;
            StopChild();
            Log("Link process exited with code " + code);
            if (code == 2 || _status == LinkStatus.Revoked)
            {
                UpdateStatus(LinkStatus.Revoked);
                return;
            }

            ScheduleReconnect();
        }

        private void ScheduleReconnect()
        {
            UpdateStatus(File.Exists(_tokenPath) ? LinkStatus.Reconnecting : LinkStatus.Unpaired);
            _restartAttempt++;
            _restartTimer.Interval = Math.Min(30000, 1000 * (1 << Math.Min(5, _restartAttempt - 1)));
            _restartTimer.Start();
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode != PowerModes.Resume) return;
            _uiContext.Post(_ =>
            {
                if (_exiting || _status == LinkStatus.Revoked || _taskActive || !File.Exists(_tokenPath)) return;
                Log("System resumed from sleep; triggering reconnect.");
                StartLinkProcess(pairMode: false);
            }, null);
        }

        private void StopChild()
        {
            if (_child == null) return;
            var child = _child;
            _child = null;
            if (_childJob != null)
            {
                _childJob.Dispose();
                _childJob = null;
            }
            SetTaskSleepInhibition(false);
            try
            {
                if (!child.HasExited)
                {
                    child.Kill();
                    child.WaitForExit(3000);
                }
            }
            catch { }
            finally
            {
                child.Dispose();
            }
        }

        private sealed class UpdateOffer
        {
            public Version Version;
            public string InstallerUrl;
            public string SumsUrl;
        }


        private static string ModeLabel(string mode)
        {
            return mode == "strict" ? "Strict / 严格（几乎都要批准）"
                : mode == "full" ? "Allow all / 全部放行"
                : "Standard / 标准（推荐）";
        }

        /** The worker token Link saved (DPAPI, current user), or null when this computer is not paired. */
        private string ReadWorkerToken()
        {
            try
            {
                if (!File.Exists(_tokenPath)) return null;
                var protectedBytes = Convert.FromBase64String(File.ReadAllText(_tokenPath, Encoding.UTF8).Trim());
                var plain = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(plain).Trim();
            }
            catch (Exception ex) { Log("Could not read the Link token: " + ex.Message); return null; }
        }

        private string WorkerLinkPost(string path, string json)
        {
            var token = ReadWorkerToken();
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(_serverUrl)) return null;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            using (var wc = new WebClient())
            {
                wc.Encoding = Encoding.UTF8;
                wc.Headers.Add("User-Agent", "SuperAgentLink/" + AppVersion);
                wc.Headers.Add("Authorization", "Bearer " + token);
                wc.Headers.Add("Content-Type", "application/json");
                return wc.UploadString(_serverUrl.TrimEnd('/') + "/api/v1/worker-link" + path, "POST", json);
            }
        }

        /** Tick the mode every employee on this computer has; none when they differ or it cannot be read. */
        private void RefreshPermissionMode()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string current = null;
                try
                {
                    var body = WorkerLinkPost("/permissions", "{}");
                    if (body != null)
                    {
                        var parsed = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                        object modesObj;
                        var modes = parsed.TryGetValue("modes", out modesObj) ? modesObj as Dictionary<string, object> : null;
                        if (modes != null && modes.Count > 0)
                        {
                            var distinct = new HashSet<string>();
                            foreach (var value in modes.Values) distinct.Add(Convert.ToString(value));
                            if (distinct.Count == 1) foreach (var only in distinct) current = only;
                        }
                    }
                }
                catch (Exception ex) { Log("Could not read the authorisation mode: " + ex.Message); }
                _uiContext.Post(__ =>
                {
                    foreach (ToolStripItem item in _modeMenu.DropDownItems)
                    {
                        var menuItem = item as ToolStripMenuItem;
                        if (menuItem != null) menuItem.Checked = current != null && (string)menuItem.Tag == current;
                    }
                }, null);
            });
        }

        private void SetPermissionMode(string mode)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string failure = null;
                try { if (WorkerLinkPost("/permissions/mode", "{\"mode\":\"" + mode + "\"}") == null) failure = "这台电脑还没有配对。"; }
                catch (Exception ex) { failure = ex.Message; }
                _uiContext.Post(__ =>
                {
                    if (failure != null)
                    {
                        Log("Could not change the authorisation mode: " + failure);
                        Notify("没能切换授权模式", failure, ToolTipIcon.Warning);
                        return;
                    }
                    Log("Authorisation mode set to " + mode);
                    Notify("授权模式：" + ModeLabel(mode), mode == "full"
                        ? "这台电脑上的员工操作会直接执行；发邮件默认仍然先问你。"
                        : "需要批准的操作会出现在指挥室的「待确认的 agent 操作」里。", ToolTipIcon.Info);
                }, null);
            });
        }

        private void CheckForUpdatesInBackground(bool manual)
        {
            ThreadPool.QueueUserWorkItem(_ => CheckForUpdatesSafe(manual));
        }

        /**
         * Look at link-latest. A newer version is offered, never installed behind the person's back: a notification
         * (click it to upgrade) and a 升级 item in the menu. `manual` also says when Link is already up to date.
         */
        private void CheckForUpdatesSafe(bool manual)
        {
            try
            {
                var offer = FetchUpdateOffer();
                _uiContext.Post(_ =>
                {
                    if (_exiting) return;
                    if (offer == null)
                    {
                        if (manual) Notify("SuperAgent Link 已是最新版本", "当前版本 " + AppVersion + "。", ToolTipIcon.Info);
                        return;
                    }
                    _offer = offer;
                    if (!_updating)
                    {
                        _updateItem.Text = "Update to v" + offer.Version + " / 升级到 v" + offer.Version;
                        _updateItem.Visible = true;
                    }
                    if (manual || _notifiedVersion != offer.Version.ToString())
                    {
                        _notifiedVersion = offer.Version.ToString();
                        _balloonClick = BeginUpdate;
                        Notify("SuperAgent Link 有新版本 v" + offer.Version,
                            "点击这里立即升级（约 1 分钟，Link 会自动重启）。也可以在托盘菜单点「升级到 v" + offer.Version + "」。", ToolTipIcon.Info);
                    }
                }, null);
            }
            catch (Exception ex)
            {
                Log("Update check skipped: " + ex.Message);
                if (manual) _uiContext.Post(_ => Notify("检查更新失败", "暂时连不上更新服务器，稍后再试。", ToolTipIcon.Warning), null);
            }
        }

        private UpdateOffer FetchUpdateOffer()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            using (var wc = new WebClient())
            {
                wc.Headers.Add("User-Agent", "SuperAgentLink/" + AppVersion);
                var json = wc.DownloadString(ReleasesApiUrl);
                // link-latest carries its version in the release title, e.g. "SuperAgent Link v0.1.3".
                var tagMatch = Regex.Match(json, "\"name\"\\s*:\\s*\"SuperAgent Link v([0-9]+\\.[0-9]+\\.[0-9]+)\"");
                if (!tagMatch.Success) return null;
                var remoteVer = new Version(tagMatch.Groups[1].Value);
                if (remoteVer <= new Version(AppVersion)) return null;
                var exeMatch = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*" + InstallerName + ")\"");
                var sumMatch = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*SHA256SUMS\\.txt)\"");
                if (!exeMatch.Success || !sumMatch.Success) return null;
                return new UpdateOffer { Version = remoteVer, InstallerUrl = exeMatch.Groups[1].Value, SumsUrl = sumMatch.Groups[1].Value };
            }
        }

        /** The person clicked 升级: download, check the SHA-256, run the installer silently; it restarts Link. */
        private void BeginUpdate()
        {
            var offer = _offer;
            if (offer == null || _updating || _exiting) return;
            if (_taskActive)
            {
                _updateAfterTask = true;
                Notify("正在执行任务", "当前任务完成后会自动升级到 v" + offer.Version + "。", ToolTipIcon.Info);
                return;
            }
            _updating = true;
            _updateItem.Enabled = false;
            _updateItem.Text = "Downloading v" + offer.Version + "… / 正在下载 v" + offer.Version + "…";
            Notify("正在升级 SuperAgent Link", "正在下载 v" + offer.Version + "，完成后会自动安装并重启。", ToolTipIcon.Info);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string tempExe = null;
                string failure = null;
                try
                {
                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                    using (var wc = new WebClient())
                    {
                        wc.Headers.Add("User-Agent", "SuperAgentLink/" + AppVersion);
                        tempExe = Path.Combine(Path.GetTempPath(), "SuperAgentLink-Setup-" + offer.Version + ".exe");
                        wc.DownloadFile(offer.InstallerUrl, tempExe);
                        var expected = ParseSha256(wc.DownloadString(offer.SumsUrl), InstallerName);
                        if (string.IsNullOrEmpty(expected) || !string.Equals(expected, FileSha256(tempExe), StringComparison.OrdinalIgnoreCase))
                            failure = "下载的安装包校验不通过，已停止升级。";
                    }
                }
                catch (Exception ex) { failure = "下载失败：" + ex.Message; }
                _uiContext.Post(__ =>
                {
                    if (failure != null || _exiting)
                    {
                        _updating = false;
                        _updateItem.Enabled = true;
                        _updateItem.Text = "Update to v" + offer.Version + " / 升级到 v" + offer.Version;
                        if (failure != null)
                        {
                            Log("Update failed: " + failure);
                            Notify("升级没有完成", failure + " 可以稍后在托盘菜单再点一次「升级」。", ToolTipIcon.Warning);
                        }
                        return;
                    }
                    if (_taskActive)
                    {
                        // A task started while downloading: install when it ends.
                        _updating = false;
                        _updateItem.Enabled = true;
                        _updateAfterTask = true;
                        return;
                    }
                    try
                    {
                        Log("Installing update " + offer.Version);
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = tempExe,
                            Arguments = "/S /D=" + _installDir.TrimEnd(Path.DirectorySeparatorChar),
                            UseShellExecute = true
                        });
                        OnExit(null, EventArgs.Empty);
                    }
                    catch (Exception ex)
                    {
                        _updating = false;
                        _updateItem.Enabled = true;
                        Log("Could not launch the update: " + ex.Message);
                        Notify("升级没有完成", "无法启动安装程序：" + ex.Message, ToolTipIcon.Warning);
                    }
                }, null);
            });
        }

        private static string ParseSha256(string sumsText, string fileName)
        {
            foreach (var raw in sumsText.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var m = Regex.Match(raw.Trim(), "^([a-fA-F0-9]{64})\\s+\\*?" + Regex.Escape(fileName) + "$");
                if (m.Success) return m.Groups[1].Value;
            }
            return null;
        }

        private static string FileSha256(string path)
        {
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(path))
            {
                var hash = sha.ComputeHash(fs);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        private void OnOpenRoom(object sender, EventArgs e)
        {
            OpenWorkspace("/#room");
        }

        private void OpenWorkspace(string route)
        {
            if (string.IsNullOrEmpty(_serverUrl))
            {
                var nextUrl = PromptServerUrl("https://");
                if (string.IsNullOrEmpty(nextUrl)) return;
                _serverUrl = nextUrl;
                SaveConfiguredServerUrl(_serverUrl);
            }
            var url = _serverUrl.TrimEnd('/') + route;
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }

        private async void OnConfigureAgent(object sender, EventArgs e)
        {
            await ShowClients(null, null);
        }

        /** After this computer first connects with no client set up, open the local clients window once. */
        private void MaybeGuideClients()
        {
            if (_clientsPrompted || _exiting) return;
            _clientsPrompted = true;
            if (ConfiguredAgents().Count > 0) return;
            Notify("连接本地客户端", "这台电脑还没有连接 Claude Code 或 Codex，已为你打开设置窗口。", ToolTipIcon.Info);
            var ignored = ShowClients(null, null);
        }

        /** Each client that has project folders on this computer, with those folders. */
        private Dictionary<string, List<string>> ConfiguredAgents()
        {
            var result = new Dictionary<string, List<string>>();
            try
            {
                var configPath = Path.Combine(_dataDir, "link-runtime.json");
                if (!File.Exists(configPath)) return result;
                var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
                object raw;
                var projects = config != null && config.TryGetValue("projects", out raw) ? raw as Dictionary<string, object> : null;
                if (projects == null) return result;
                foreach (var entry in projects.Values)
                {
                    var project = entry as Dictionary<string, object>;
                    object agent, directory;
                    if (project == null || !project.TryGetValue("agent", out agent) || !project.TryGetValue("directory", out directory)) continue;
                    var key = agent as string;
                    if (key == null) continue;
                    if (!result.ContainsKey(key)) result[key] = new List<string>();
                    result[key].Add(Path.GetFileName((directory as string ?? "").TrimEnd('\\', '/')));
                }
            }
            catch (Exception ex) { Log("Could not read link-runtime.json: " + ex.Message); }
            return result;
        }

        /**
         * The local clients window. Claude Code and Codex each get one row with where they stand and the one step that
         * comes next: install (and sign in), sign in, or choose a project folder. Several clients can be connected,
         * also to the same folder. A step can start by itself (asked from the web page, or after pairing).
         */
        private async Task ShowClients(string autoAgent, string autoAction)
        {
            if (_clientsOpen || _exiting) return;
            _clientsOpen = true;
            var changed = false;
            try
            {
                var serializer = new JavaScriptSerializer();
                var setupScript = Path.Combine(Path.GetDirectoryName(_linkEntry), "setup-agents.mjs");
                using (var form = new Form())
                using (var intro = new Label())
                using (var rows = new Panel())
                using (var status = new Label())
                using (var close = new Button())
                {
                    form.Text = "Local clients / 本地客户端";
                    form.ClientSize = new Size(520, 330);
                    form.StartPosition = FormStartPosition.CenterScreen;
                    form.FormBorderStyle = FormBorderStyle.FixedDialog;
                    form.MaximizeBox = false;
                    form.MinimizeBox = false;
                    form.TopMost = true;
                    intro.Text = "Super Agent 通过这台电脑上的客户端干活。可以连接多个客户端；每一步点按钮即可，登录在弹出的窗口或浏览器里完成。";
                    intro.SetBounds(12, 12, 496, 40);
                    rows.SetBounds(12, 58, 496, 196);
                    status.SetBounds(12, 258, 496, 34);
                    close.Text = "完成 / Done";
                    close.DialogResult = DialogResult.OK;
                    close.SetBounds(408, 294, 100, 28);
                    form.Controls.AddRange(new Control[] { intro, rows, status, close });
                    form.AcceptButton = close;
                    form.CancelButton = close;

                    Dictionary<string, object>[] choices = null;
                    Func<Task> render = null;
                    Func<Dictionary<string, object>, Task> act = async (choice) =>
                    {
                        foreach (Control control in rows.Controls) control.Enabled = false;
                        close.Enabled = false;
                        try
                        {
                            var id = choice["agent"] as string;
                            if (!"ready".Equals(choice["state"]))
                            {
                                var signedIn = await InstallAndSignIn(serializer, setupScript, choice, status);
                                status.Text = AgentLabel(id) + " 已可以使用。最后选一个项目文件夹。";
                                choice = signedIn ?? choice;
                                object executable;
                                if (signedIn != null && signedIn.TryGetValue("executable", out executable) && executable is string) choice["executable"] = executable;
                            }
                            if (ConnectFolder(choice)) { changed = true; status.Text = AgentLabel(id) + " 已连接。可以继续连接其他客户端，或点「完成」。"; }
                        }
                        catch (Exception ex)
                        {
                            Log("Local client setup failed: " + ex.Message);
                            status.Text = ex.Message;
                        }
                        close.Enabled = true;
                        await render();
                    };
                    render = async () =>
                    {
                        status.Text = status.Text.Length == 0 ? "正在检查这台电脑上的客户端…" : status.Text;
                        choices = serializer.Deserialize<Dictionary<string, object>[]>(await Task.Run(() => RunNodeScript(setupScript, "")));
                        var configured = ConfiguredAgents();
                        rows.Controls.Clear();
                        var top = 0;
                        foreach (var choice in choices)
                        {
                            var id = choice["agent"] as string;
                            var state = choice["state"] as string;
                            List<string> folders;
                            var connected = configured.TryGetValue(id, out folders) && folders.Count > 0;
                            var line = new Label();
                            line.AutoSize = false;
                            line.SetBounds(0, top + 6, 330, 40);
                            line.Text = AgentLabel(id) + "\r\n" + ("missing".Equals(state) ? "未安装"
                                : "signed-out".Equals(state) ? "已安装，还没登录"
                                : connected ? "已连接 · 项目：" + string.Join("、", folders.ToArray())
                                : "已登录，还没连接项目文件夹");
                            var button = new Button();
                            button.SetBounds(340, top + 8, 156, 32);
                            button.Text = "missing".Equals(state) ? "安装并登录" : "signed-out".Equals(state) ? "登录" : connected ? "再连接一个文件夹" : "选择项目文件夹";
                            var selected = choice;
                            button.Click += async (s2, ev2) => await act(selected);
                            rows.Controls.Add(line);
                            rows.Controls.Add(button);
                            top += 52;
                        }
                        if (status.Text == "正在检查这台电脑上的客户端…") status.Text = "";
                    };
                    form.Shown += async (s2, ev2) =>
                    {
                        try
                        {
                            await render();
                            if (autoAgent == null) return;
                            foreach (var choice in choices)
                                if (autoAgent.Equals(choice["agent"])) { await act(choice); break; }
                        }
                        catch (Exception ex)
                        {
                            Log("Local client check failed: " + ex.Message);
                            status.Text = "检查客户端失败，请查看 Link 日志。";
                        }
                    };
                    form.ShowDialog();
                }
                if (changed)
                {
                    if (_taskActive) _restartAfterTask = true;
                    else StartLinkProcess(pairMode: false);
                    OpenWorkspace("/#settings?section=computers");
                }
            }
            catch (Exception ex)
            {
                Log("Local setup failed: " + ex.Message);
                MessageBox.Show("Local setup failed. Open Link logs for details. / 配置失败，请查看 Link 日志。", "SuperAgent Link");
            }
            finally { _clientsOpen = false; }
        }

        /**
         * Choose the project folder a client works in and save it. One entry per folder and client, so the same folder
         * can be worked on by Claude Code and by Codex.
         */
        private bool ConnectFolder(Dictionary<string, object> client)
        {
            var serializer = new JavaScriptSerializer();
            var configPath = Path.Combine(_dataDir, "link-runtime.json");
            var config = File.Exists(configPath)
                ? serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath))
                : new Dictionary<string, object>();
            object rawProjects;
            var projects = config.TryGetValue("projects", out rawProjects)
                ? (Dictionary<string, object>)rawProjects : new Dictionary<string, object>();
            using (var folder = new FolderBrowserDialog())
            {
                folder.Description = "Choose the folder " + AgentLabel(client["agent"] as string) + " can work in / 选择它可以使用的项目文件夹";
                folder.ShowNewFolderButton = false;
                if (folder.ShowDialog() != DialogResult.OK) return false;
                if (string.Equals(Path.GetPathRoot(folder.SelectedPath), folder.SelectedPath, StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show("Choose a project folder inside the drive. / 请选择磁盘下的项目文件夹。", "SuperAgent Link");
                    return false;
                }
                string projectId = null;
                Dictionary<string, object> project = null;
                foreach (var entry in projects)
                {
                    var saved = entry.Value as Dictionary<string, object>;
                    object directory, agent;
                    if (saved != null && saved.TryGetValue("directory", out directory) && saved.TryGetValue("agent", out agent)
                        && string.Equals(directory as string, folder.SelectedPath, StringComparison.OrdinalIgnoreCase)
                        && Equals(agent, client["agent"]))
                    {
                        projectId = entry.Key;
                        project = saved;
                        break;
                    }
                }
                if (project == null) project = new Dictionary<string, object>();
                project["directory"] = folder.SelectedPath;
                project["agent"] = client["agent"];
                project["executable"] = client["executable"];
                projects[projectId ?? Guid.NewGuid().ToString()] = project;
                config["projects"] = projects;
                var temporary = configPath + ".tmp";
                File.WriteAllText(temporary, serializer.Serialize(config), new UTF8Encoding(false));
                if (File.Exists(configPath)) File.Replace(temporary, configPath, null);
                else File.Move(temporary, configPath);
                return true;
            }
        }

        private string RunNodeScript(string script, string extra)
        {
            var stderr = new StringBuilder();
            using (var process = Process.Start(new ProcessStartInfo
            {
                FileName = _nodeExe,
                Arguments = "\"" + script + "\"" + (string.IsNullOrEmpty(extra) ? "" : " " + extra),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            }))
            {
                process.ErrorDataReceived += (s, ev) => { if (ev.Data != null) stderr.AppendLine(ev.Data); };
                process.BeginErrorReadLine();
                var stdout = process.StandardOutput.ReadToEnd();
                process.WaitForExit();
                var payload = (stdout ?? "").Trim();
                if (process.ExitCode != 0 && !payload.StartsWith("{") && !payload.StartsWith("["))
                    throw new InvalidOperationException(stderr.Length > 0 ? stderr.ToString().Trim() : "命令行检测失败。");
                return payload;
            }
        }

        private async Task<Dictionary<string, object>> InstallAndSignIn(
            JavaScriptSerializer serializer, string setupScript, Dictionary<string, object> choice, Label status)
        {
            var id = choice["agent"] as string;
            var label = (choice["label"] as string) ?? id;
            var executable = choice["executable"] as string;
            if ("install".Equals(choice["action"]))
            {
                status.Text = "正在安装 " + label + "…";
                var raw = await Task.Run(() => RunNodeScript(setupScript, "install " + id));
                var result = serializer.Deserialize<Dictionary<string, object>>(raw);
                if (!true.Equals(result["ok"]))
                {
                    object error;
                    throw new InvalidOperationException(result.TryGetValue("error", out error) && error != null
                        ? error.ToString() : "安装失败。");
                }
                executable = result["executable"] as string;
                object loginArgs;
                if (result.TryGetValue("loginArgs", out loginArgs)) choice["loginArgs"] = loginArgs;
                if (true.Equals(result["signedIn"]))
                {
                    result["agent"] = id;
                    result["label"] = label;
                    return result;
                }
            }
            if (string.IsNullOrEmpty(executable)) throw new InvalidOperationException("没有找到 " + label + " 命令行。");
            status.Text = "已打开 " + label + " 登录。请在弹出的窗口或浏览器里完成登录，完成后会自动继续。";
            object rawLogin;
            var loginArgsText = JoinArgs(choice.TryGetValue("loginArgs", out rawLogin) ? rawLogin : null);
            var start = new ProcessStartInfo { UseShellExecute = true };
            if (executable.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            {
                start.FileName = _nodeExe;
                start.Arguments = "\"" + executable + "\" " + loginArgsText;
            }
            else
            {
                start.FileName = executable;
                start.Arguments = loginArgsText;
            }
            var login = Process.Start(start);
            for (var attempt = 0; attempt < 150; attempt++)
            {
                await Task.Run(() => Thread.Sleep(2000));
                var again = serializer.Deserialize<Dictionary<string, object>[]>(
                    await Task.Run(() => RunNodeScript(setupScript, "")));
                foreach (var agent in again)
                {
                    if (string.Equals(agent["agent"] as string, id, StringComparison.Ordinal) && "ready".Equals(agent["state"]))
                        return agent;
                }
                if (login != null && login.HasExited)
                    throw new InvalidOperationException("登录未完成，请再试一次。");
            }
            throw new InvalidOperationException("登录超时，请再试一次。");
        }

        private static string JoinArgs(object raw)
        {
            if (raw == null) return "";
            var items = raw as System.Collections.IEnumerable;
            if (items == null || raw is string) return raw.ToString();
            var parts = new List<string>();
            foreach (var item in items) if (item != null) parts.Add(item.ToString());
            return string.Join(" ", parts.ToArray());
        }

        private void OnRepair(object sender, EventArgs e)
        {
            if (string.IsNullOrEmpty(_serverUrl))
            {
                var nextUrl = PromptServerUrl("https://");
                if (string.IsNullOrEmpty(nextUrl)) return;
                _serverUrl = nextUrl;
                SaveConfiguredServerUrl(_serverUrl);
            }
            try { if (File.Exists(_tokenPath)) File.Delete(_tokenPath); } catch { }
            UpdateStatus(LinkStatus.Unpaired);
            StartLinkProcess(pairMode: true);
        }

        private void OnViewLogs(object sender, EventArgs e)
        {
            if (!File.Exists(_logPath)) File.WriteAllText(_logPath, string.Empty, Encoding.UTF8);
            Process.Start(new ProcessStartInfo { FileName = "notepad.exe", Arguments = "\"" + _logPath + "\"", UseShellExecute = true });
        }

        private void OnExit(object sender, EventArgs e)
        {
            Cleanup();
            ExitThread();
        }

        private void Cleanup()
        {
            if (_exiting) return;
            _exiting = true;
            _restartTimer.Dispose();
            SetTaskSleepInhibition(false);
            try { if (_updateTimer != null) _updateTimer.Dispose(); } catch { }
            try { SystemEvents.PowerModeChanged -= OnPowerModeChanged; } catch { }
            StopChild();
            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
            }
            if (_currentIcon != null) _currentIcon.Dispose();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (args != null && args.Length > 0 && args[0] == "--self-check")
            {
                Console.WriteLine("{\"ok\":true,\"version\":\"" + TrayApp.AppVersion + "\"}");
                return;
            }
            if (args.Length == 0 || args[0] != "--tray")
            {
                SuperviseTray();
                return;
            }

            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\SuperAgentLinkTray", out createdNew))
            {
                if (!createdNew) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
            }
        }

        private static void SuperviseTray()
        {
            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\SuperAgentLinkSupervisor", out createdNew))
            {
                if (!createdNew) return;

                while (true)
                {
                    using (var tray = Process.Start(new ProcessStartInfo
                    {
                        FileName = Assembly.GetExecutingAssembly().Location,
                        Arguments = "--tray",
                        UseShellExecute = false
                    }))
                    {
                        tray.WaitForExit();
                        if (tray.ExitCode == 0) return;
                    }
                    Thread.Sleep(1000);
                }
            }
        }
    }
}
