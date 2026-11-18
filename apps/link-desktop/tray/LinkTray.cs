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
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

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
        private const string AppVersion = "0.1.0";
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
        private readonly object _procLock = new object();
        private readonly System.Threading.Timer _updateTimer;
        private readonly System.Threading.Timer _tokenPollTimer;

        private Process _child;
        private volatile bool _exiting;
        private volatile bool _taskActive;
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

            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            AppDomain.CurrentDomain.ProcessExit += (s, e) => Cleanup();

            StartLinkProcess(pairMode: false);
            _tokenPollTimer = new System.Threading.Timer(_ => PollTokenStateSafe(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2));
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

        private void PollTokenStateSafe()
        {
            if (_exiting || _status == LinkStatus.Revoked) return;
            try
            {
                bool running;
                lock (_procLock) { running = _child != null && !_child.HasExited; }
                if (!running) return;
                bool hasToken = File.Exists(_tokenPath);
                if (hasToken && (_status == LinkStatus.Unpaired || _status == LinkStatus.Reconnecting))
                {
                    _restartAttempt = 0;
                    UpdateStatus(LinkStatus.Connected);
                }
                else if (!hasToken && _status == LinkStatus.Connected)
                {
                    UpdateStatus(LinkStatus.Unpaired);
                }
            }
            catch { }
        }

        private void Log(string line)
        {
            try
            {
                lock (_procLock)
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

            Action apply = () =>
            {
                _statusItem.Text = "状态: " + label;
                _tray.Text = ("SuperAgent Link - " + label).Length > 63
                    ? ("SuperAgent Link - " + label).Substring(0, 63)
                    : "SuperAgent Link - " + label;
                var prev = _currentIcon;
                _currentIcon = BuildStatusIcon(color);
                _tray.Icon = _currentIcon;
                if (prev != null) prev.Dispose();
            };

            if (_tray.ContextMenuStrip != null && _tray.ContextMenuStrip.InvokeRequired)
                _tray.ContextMenuStrip.BeginInvoke(apply);
            else
                apply();
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

            lock (_procLock)
            {
                StopChildLocked();
                var args = "\"" + _linkEntry + "\"";
                var psi = new ProcessStartInfo
                {
                    FileName = _nodeExe,
                    Arguments = args,
                    WorkingDirectory = _dataDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    RedirectStandardInput = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                psi.EnvironmentVariables["SUPERAGENT_ORIGIN"] = _serverUrl;
                psi.EnvironmentVariables["SUPERAGENT_LINK_DATA_DIR"] = _dataDir;

                var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) HandleLinkLine(e.Data); };
                proc.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data == null) return;
                    Log("[stderr] " + e.Data);
                    if (e.Data.IndexOf("revoked", StringComparison.OrdinalIgnoreCase) >= 0)
                        UpdateStatus(LinkStatus.Revoked);
                };
                proc.Exited += (s, e) => OnChildExited(proc);

                _child = proc;
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                UpdateStatus(File.Exists(_tokenPath) ? LinkStatus.Connected : LinkStatus.Unpaired);
                Log("Started link process pid=" + proc.Id + " origin=" + _serverUrl + (pairMode ? " (re-pair)" : ""));
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
            SetTaskSleepInhibition(false);
            if (_exiting) return;
            int code = -1;
            try { code = exited.ExitCode; } catch { }
            Log("Link process exited with code " + code);
            if (code == 2 || _status == LinkStatus.Revoked)
            {
                UpdateStatus(LinkStatus.Revoked);
                return;
            }

            UpdateStatus(LinkStatus.Reconnecting);
            _restartAttempt++;
            int delayMs = Math.Min(30000, 1000 * (1 << Math.Min(5, _restartAttempt - 1)));
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Thread.Sleep(delayMs);
                if (!_exiting && _status != LinkStatus.Revoked) StartLinkProcess(pairMode: false);
            });
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode != PowerModes.Resume || _exiting) return;
            Log("System resumed from sleep; triggering reconnect.");
            UpdateStatus(LinkStatus.Reconnecting);
            lock (_procLock)
            {
                if (_child != null && !_child.HasExited)
                {
                    try { _child.StandardInput.WriteLine("reconnect"); return; }
                    catch { /* fallback to restart */ }
                }
            }
            StartLinkProcess(pairMode: false);
        }

        private void StopChildLocked()
        {
            if (_child == null) return;
            try
            {
                if (!_child.HasExited)
                {
                    _child.Kill();
                    _child.WaitForExit(3000);
                }
            }
            catch { }
            finally
            {
                _child.Dispose();
                _child = null;
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

                    Log("Launching silent auto-update to " + remoteVer);
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = tempExe,
                        Arguments = "/S /RESTART",
                        UseShellExecute = true
                    });
                    OnExit(null, EventArgs.Empty);
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
            SetTaskSleepInhibition(false);
            try { if (_tokenPollTimer != null) _tokenPollTimer.Dispose(); } catch { }
            try { if (_updateTimer != null) _updateTimer.Dispose(); } catch { }
            try { SystemEvents.PowerModeChanged -= OnPowerModeChanged; } catch { }
            lock (_procLock) { StopChildLocked(); }
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
                Console.WriteLine("{\"ok\":true,\"version\":\"0.1.0\"}");
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
