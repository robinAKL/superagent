!include "MUI2.nsh"
!include "x64.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif
!ifndef STAGE_DIR
  !define STAGE_DIR "..\dist\staging"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\dist\SuperAgentLink-Setup-x64.exe"
!endif
!ifndef LINK_ICON
  !define LINK_ICON "..\assets\SuperAgentLink.ico"
!endif

Name "SuperAgent Link ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\SuperAgentLink"
RequestExecutionLevel user
Unicode True

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperAgentLink"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!define MUI_ICON "${LINK_ICON}"
!define MUI_UNICON "${LINK_ICON}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchLink
!define MUI_FINISHPAGE_RUN_TEXT "Launch SuperAgent Link now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function LaunchLink
  nsExec::ExecToLog 'schtasks /Run /TN "SuperAgentLink"'
  Pop $0
  StrCmp $0 "0" launch_done
  Exec '"$INSTDIR\SuperAgentLink.exe"'
launch_done:
FunctionEnd

Section "Main" SecMain
  SetOutPath "$INSTDIR"
  ; The tray's Windows job closes the worker tree. Leave any running updater alone.
  nsExec::ExecToLog 'taskkill /F /IM SuperAgentLink.exe'

  File /r "${STAGE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\SuperAgent Link.lnk" "$INSTDIR\SuperAgentLink.exe"

  ; Add/Remove Programs registration
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "SuperAgent Link"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\SuperAgentLink.exe,0"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "SuperAgent"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; Logon task starts the supervisor in the user's desktop session.
  DeleteRegValue HKCU "${RUN_KEY}" "SuperAgentLink"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\Register-LogonTask.ps1" -TrayPath "$INSTDIR\SuperAgentLink.exe"'
  Pop $0
  StrCmp $0 "0" task_registered
  WriteRegStr HKCU "${RUN_KEY}" "SuperAgentLink" '"$INSTDIR\SuperAgentLink.exe"'
task_registered:

  ; Start immediately after a silent install or upgrade.
  IfSilent 0 +2
    Call LaunchLink
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'taskkill /F /IM SuperAgentLink.exe'
  nsExec::ExecToLog 'schtasks /Delete /TN "SuperAgentLink" /F'
  DeleteRegValue HKCU "${RUN_KEY}" "SuperAgentLink"
  DeleteRegKey HKCU "${UNINST_KEY}"
  Delete "$SMPROGRAMS\SuperAgent Link.lnk"

  ; Clean install directory and user token/config/logs
  Delete "$INSTDIR\SuperAgentLink.exe"
  Delete "$INSTDIR\Register-LogonTask.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\app\link"
  RMDir "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  RMDir "$INSTDIR"
  RMDir /r "$LOCALAPPDATA\SuperAgentLink"
  Delete "$APPDATA\SuperAgent\link.token"
  RMDir "$APPDATA\SuperAgent"
SectionEnd
