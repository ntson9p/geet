@echo off
rem Geet askpass launcher for environments without a POSIX sh.
set ELECTRON_RUN_AS_NODE=1
"%VSCODE_GITTREE_NODE%" "%~dp0askpass.cjs" %*
