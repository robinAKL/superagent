using System;
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
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

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
        private const string ReleasesApiUrl = "https://api.github.com/repos/robinAKL/superagent/releases/latest";
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
        private volatile bool _exiting;
        private bool _taskActive;
        private LinkStatus _status = LinkStatus.Unpaired;
        private int _restartAttempt;
        private Icon _currentIcon;

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
            var repairItem = new ToolStripMenuItem("Re-pair / 重新配对", null, OnRepair);
            var logsItem = new ToolStripMenuItem("View Logs / 查看日志", null, OnViewLogs);
            var exitItem = new ToolStripMenuItem("Exit / 退出", null, OnExit);

            var menu = new ContextMenuStrip();
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openRoomItem);
            menu.Items.Add(repairItem);
            menu.Items.Add(logsItem);
            menu.Items.Add(new ToolStripSeparator());
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
            _updateTimer = new System.Threading.Timer(_ => CheckForUpdatesSafe(), null, TimeSpan.FromSeconds(15), TimeSpan.FromHours(6));
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
                if (s == "connected") { _restartAttempt = 0; UpdateStatus(LinkStatus.Connected); }
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

        private void CheckForUpdatesSafe()
        {
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                using (var wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "SuperAgentLink/" + AppVersion);
                    var json = wc.DownloadString(ReleasesApiUrl);
                    var tagMatch = Regex.Match(json, "\"tag_name\"\\s*:\\s*\"link-v([0-9]+\\.[0-9]+\\.[0-9]+)\"");
                    if (!tagMatch.Success) return;
                    var remoteVer = new Version(tagMatch.Groups[1].Value);
                    var localVer = new Version(AppVersion);
                    if (remoteVer <= localVer) return;

                    var exeMatch = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*" + InstallerName + ")\"");
                    var sumMatch = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*SHA256SUMS\\.txt)\"");
                    if (!exeMatch.Success || !sumMatch.Success) return;

                    var tempExe = Path.Combine(Path.GetTempPath(), InstallerName);
                    wc.DownloadFile(exeMatch.Groups[1].Value, tempExe);
                    var sums = wc.DownloadString(sumMatch.Groups[1].Value);
                    var expected = ParseSha256(sums, InstallerName);
                    if (string.IsNullOrEmpty(expected) || !string.Equals(expected, FileSha256(tempExe), StringComparison.OrdinalIgnoreCase))
                    {
                        Log("Auto-update SHA-256 mismatch; aborting.");
                        return;
                    }

                    _uiContext.Post(_ =>
                    {
                        if (_exiting || _taskActive) return;
                        try
                        {
                            Log("Launching silent auto-update to " + remoteVer);
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = tempExe,
                                Arguments = "/S /D=" + _installDir.TrimEnd(Path.DirectorySeparatorChar),
                                UseShellExecute = true
                            });
                            OnExit(null, EventArgs.Empty);
                        }
                        catch (Exception ex) { Log("Could not launch the update: " + ex.Message); }
                    }, null);
                }
            }
            catch (Exception ex)
            {
                Log("Update check skipped: " + ex.Message);
            }
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
            if (string.IsNullOrEmpty(_serverUrl))
            {
                var nextUrl = PromptServerUrl("https://");
                if (string.IsNullOrEmpty(nextUrl)) return;
                _serverUrl = nextUrl;
                SaveConfiguredServerUrl(_serverUrl);
            }
            var url = (_serverUrl.TrimEnd('/')) + "/#command";
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
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
            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\SuperAgentLinkTray", out createdNew))
            {
                if (!createdNew) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
            }
        }
    }
}
