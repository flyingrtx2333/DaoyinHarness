import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pickWorkspaceDirectory } from "../packages/server/dist/folder-picker.js";

// Close only a dialog belonging to a direct child of this acceptance process.
// No user application or existing dialog is targeted.
assert.equal(process.platform, "win32");
const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PickerAcceptance {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  private delegate bool EnumWindow(IntPtr window, IntPtr arg);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr arg);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  public static IntPtr Dialog(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, arg) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == processId && IsWindowVisible(window)) { found = window; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}"
  foreach ($child in $children) {
    if ($child.ProcessId -eq $PID) { continue }
    $window = [PickerAcceptance]::Dialog($child.ProcessId)
    if ($window -ne [IntPtr]::Zero) {
      [void][PickerAcceptance]::SendMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      [Console]::Write('native-dialog-observed-and-closed')
      exit 0
    }
  }
  Start-Sleep -Milliseconds 100
}
exit 1
`;
const automation = promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 });
const [root, observer] = await Promise.all([pickWorkspaceDirectory(), automation]);
assert.equal(root, null);
assert.equal(observer.stdout, "native-dialog-observed-and-closed");
await mkdir("evidence/workspace-management", { recursive: true });
await writeFile("evidence/workspace-management/native-picker-acceptance.json", JSON.stringify({ checkedAt: new Date().toISOString(), environment: "Windows native FolderBrowserDialog", dialogObserved: true, cancellationReturnedNull: true, selectionConfirmedByHuman: false }, null, 2));
console.log("Native folder dialog opened and cancellation returned null.");
