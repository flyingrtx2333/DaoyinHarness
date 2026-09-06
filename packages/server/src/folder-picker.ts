import { execFile } from "node:child_process";

// Fixed script: no directory names or browser-provided input become shell code.
const PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Select a workspace folder'
$picker.ShowNewFolderButton = $false
try {
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picker.SelectedPath)))
  }
} finally { $picker.Dispose() }
`;

export async function pickWorkspaceDirectory(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw Object.assign(new Error("当前系统请通过完整路径打开工作区。"), { code: "WORKSPACE_PICKER_UNAVAILABLE" });
  }
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(PICKER_SCRIPT, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 180_000, maxBuffer: 32_768 }, (error, stdout) => {
        if (error !== null) {
          reject(Object.assign(new Error("文件夹选择窗口未能完成，请重试或直接输入路径。"), { code: "WORKSPACE_PICKER_FAILED" }));
        } else {
          resolve(stdout.trim().length === 0 ? null : Buffer.from(stdout.trim(), "base64").toString("utf8"));
        }
      });
  });
}
