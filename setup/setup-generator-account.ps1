<#
WITHDRAWN 2026-10-08. Do not run.

This script created a restricted Windows account for the Dashboard's Claude Code generator and
confined it by adding deny rules across whole drives. An external security review found that
approach too broad and its rollback not trustworthy (drive-wide permission rewrites, an undo file
that an elevated undo would trust, undo that could remove settings it did not add, reuse of an
existing account, incomplete read verification).

The generator boundary is being redesigned around an isolated environment (a dedicated WSL2
distribution) that needs no permission changes on your Windows drives.

This stub refuses to run.
#>
Write-Host "setup-generator-account.ps1 has been withdrawn and does nothing. See the comment at the top of this file."
exit 1
