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

Name "SuperAgent Link ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\SuperAgentLink"
RequestExecutionLevel user
Unicode True

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperAgentLink"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\SuperAgentLink.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch SuperAgent Link now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Main" SecMain
  SetOutPath "$INSTDIR"
  ; Stop existing processes cleanly before overwriting binaries (important for /S auto-update)
  nsExec::ExecToLog 'taskkill /F /IM SuperAgentLink.exe /T'

  File /r "${STAGE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Add/Remove Programs registration
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "SuperAgent Link"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "SuperAgent"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; Interactive logon auto-start + crash restart via Scheduled Task (preferred over Windows Service so tray, sleep-inhibition, browser pairing, and user CLI tools work in the interactive desktop session)
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName ''SuperAgentLink'' -Confirm:`$false -ErrorAction SilentlyContinue; `$a = New-ScheduledTaskAction -Execute ''$INSTDIR\SuperAgentLink.exe''; `$t = New-ScheduledTaskTrigger -AtLogOn -User `$env:USERNAME; `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew; Register-ScheduledTask -TaskName ''SuperAgentLink'' -Action `$a -Trigger `$t -Settings `$s -Force | Out-Null"'

  ; Fallback HKCU Run key
  WriteRegStr HKCU "${RUN_KEY}" "SuperAgentLink" '"$INSTDIR\SuperAgentLink.exe"'

  ; Start immediately after silent upgrade or /RESTART
  IfSilent 0 +2
    Exec '"$INSTDIR\SuperAgentLink.exe"'
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'taskkill /F /IM SuperAgentLink.exe /T'
  nsExec::ExecToLog 'schtasks /Delete /TN "SuperAgentLink" /F'
  DeleteRegValue HKCU "${RUN_KEY}" "SuperAgentLink"
  DeleteRegKey HKCU "${UNINST_KEY}"

  ; Clean install directory and user token/config/logs
  RMDir /r "$INSTDIR"
  RMDir /r "$LOCALAPPDATA\SuperAgentLink"
  Delete "$APPDATA\SuperAgent\link.token"
  RMDir "$APPDATA\SuperAgent"
SectionEnd
