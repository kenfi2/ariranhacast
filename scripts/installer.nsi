; Instalador do AriranhaCast. Instala só para o usuário atual (não pede administrador).
; Compilado por scripts/dist.mjs com: makensis -DSRC=<pasta do app> -DOUT=<saída> -DVERSION=<versão>
Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APP "AriranhaCast"
!define EXE "AriranhaCast.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

Name "${APP}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP}"
SetCompressor /SOLID lzma
Icon "..\assets\icon.ico"
UninstallIcon "..\assets\icon.ico"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
BrandingText "${APP} ${VERSION}"

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

; Espera o AriranhaCast fechar (a atualização automática chama o instalador quando o app sai).
Function WaitForApp
  StrCpy $R1 0
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $R0 "$INSTDIR\${EXE}" a
    ${IfNot} ${Errors}
      FileClose $R0
      ${ExitDo}
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 > 30
      ${If} ${Silent}
        Abort
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O AriranhaCast está aberto. Feche-o (ícone da bandeja > Fechar o AriranhaCast) e tente de novo." IDRETRY again
      Abort
      again:
      StrCpy $R1 0
    ${EndIf}
    Sleep 500
  ${Loop}
FunctionEnd

Section "Install"
  Call WaitForApp
  ; remove os arquivos do app da versão anterior (os dados do usuário ficam em %APPDATA%)
  RMDir /r "$INSTDIR\resources"
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Desinstalar ${APP}.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Desinstalar ${APP}.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; Abre o app ao terminar: sempre na instalação normal; na silenciosa só com --force-run.
Function .onInstSuccess
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${EXE}"'
  ${ElseIfNot} ${Silent}
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; só apaga a pasta se ela for mesmo uma instalação do AriranhaCast
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    RMDir /r "$INSTDIR"
  ${EndIf}
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
