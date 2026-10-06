# Cleanup only: compact the stopped Docker data disk without deleting its contents.
$ErrorActionPreference = 'Stop'
$diskPath = [IO.Path]::GetFullPath('C:/Users/thefo/AppData/Local/Docker/wsl/disk/docker_data.vhdx')
$expectedPath = 'C:\Users\thefo\AppData\Local\Docker\wsl\disk\docker_data.vhdx'
$reportPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs/3d-pilot/disk-compaction.json'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$report = @{ status = 'checking'; disk = $diskPath; startedAt = (Get-Date).ToString('o') }
try {
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Windows administrator approval is required.'
    }
    if ($diskPath -ne $expectedPath) { throw 'Unexpected disk path.' }
    if ((Get-Item -LiteralPath $diskPath).LinkType) { throw 'Disk path must not be a link.' }
    if (Get-Process -Name 'com.docker.backend','Docker Desktop' -ErrorAction SilentlyContinue) {
        throw 'Docker Desktop must remain stopped during compaction.'
    }
    Import-Module Hyper-V
    $before = Get-VHD -Path $diskPath
    if ($before.Attached) { throw 'The virtual disk is attached; no compaction will run.' }
    if ($before.VhdType -ne 'Dynamic') { throw 'Expected a dynamic virtual disk.' }
    $report.beforeFileBytes = (Get-Item -LiteralPath $diskPath).Length
    $report.beforeFreeBytes = (Get-PSDrive C).Free
    $report.status = 'compacting'
    $report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Optimize-VHD -Path $diskPath -Mode Pretrimmed
    Optimize-VHD -Path $diskPath -Mode Prezeroed
    $after = Get-VHD -Path $diskPath
    if ($before.Size -ne $after.Size -or $before.DiskIdentifier -ne $after.DiskIdentifier) {
        throw 'Unexpected disk identity/capacity change.'
    }
    $report.afterFileBytes = (Get-Item -LiteralPath $diskPath).Length
    $report.afterFreeBytes = (Get-PSDrive C).Free
    $report.status = 'complete'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
} finally {
    $report.finishedAt = (Get-Date).ToString('o')
    $report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8
}
