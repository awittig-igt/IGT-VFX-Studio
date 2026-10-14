function Invoke-UnityEditorProcess {
    param(
        [Parameter(Mandatory = $true)][string]$EditorPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    # Start-Process -Wait waits for descendants too; Unity helpers can outlive the Editor.
    $process = Start-Process -FilePath $EditorPath -ArgumentList $Arguments -WindowStyle Hidden -PassThru -ErrorAction Stop
    $null = $process.Handle
    $process.WaitForExit()
    $process.Refresh()
    return $process
}
