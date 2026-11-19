param(
    [int]$AppProcessId,
    [ValidateSet("resize", "visible", "hidden")][string]$Action,
    [int]$Width,
    [int]$Height
)

$ErrorActionPreference = "Stop"
Add-Type -Name Window -Namespace ModelGaugeQA -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, IntPtr className, string title);
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")]
public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
'@

# The tray process can own another top-level window while the panel is hidden.
$handle = [IntPtr]::Zero
do {
    $handle = [ModelGaugeQA.Window]::FindWindowEx([IntPtr]::Zero, $handle, [IntPtr]::Zero, "ModelGauge")
    if ($handle -eq [IntPtr]::Zero) { throw "ModelGauge panel missing from process $AppProcessId" }
    [uint32]$owner = 0
    [void][ModelGaugeQA.Window]::GetWindowThreadProcessId($handle, [ref]$owner)
} until ($owner -eq $AppProcessId)

if ($Action -eq "resize") {
    # SWP_NOMOVE | SWP_NOZORDER preserves the panel's tray position.
    if (-not [ModelGaugeQA.Window]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $Width, $Height, 6)) {
        throw "Could not resize the ModelGauge window"
    }
    return
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([ModelGaugeQA.Window]::IsWindowVisible($handle) -ne ($Action -eq "visible")) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "Expected ModelGauge panel to be $Action" }
    Start-Sleep -Milliseconds 50
}
