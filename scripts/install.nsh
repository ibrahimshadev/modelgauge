!macro NSIS_HOOK_POSTINSTALL
  ; Reduce offline runtime size on NTFS. Other filesystems use the plain binaries.
  nsExec::ExecToStack '"$SYSDIR\compact.exe" /C /EXE:LZX /I /Q "$INSTDIR\modelgauge.exe" "$INSTDIR\modelgauge-node.exe" "$INSTDIR\wsl\node"'
  Pop $0
  Pop $0
!macroend
