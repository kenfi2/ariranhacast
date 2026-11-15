; Instalador do AriranhaCast. Instala só para o usuário atual (não pede administrador).
; Compilado por scripts/dist.mjs com: makensis -DSRC=<pasta do app> -DOUT=<saída> -DVERSION=<versão>
Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef NEEDMB
  !define NEEDMB 450
!endif

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

; Confere o espaço livre ANTES de mexer em qualquer arquivo: sem espaço no meio da cópia a
; instalação anterior já teria sido apagada e o app ficaria sem abrir.
Function CheckSpace
  StrCpy $R2 $INSTDIR 3
  StrCpy $R3 $R2 1 1
  ${If} $R3 != ":"
    Return
  ${EndIf}
  ClearErrors
  ${DriveSpace} "$R2" "/D=F /S=M" $R0
  ${If} ${Errors}
    Return
  ${EndIf}
  ${If} $R0 < ${NEEDMB}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Não há espaço suficiente no disco $R2 para instalar o AriranhaCast.$\r$\n$\r$\nLibere pelo menos ${NEEDMB} MB (agora há $R0 MB livres) e abra o instalador de novo. Nada foi alterado."
    ${EndIf}
    Abort
  ${EndIf}
FunctionEnd

Var Stage   ; pasta onde a versão nova é copiada antes da troca
Var Backup  ; versão anterior, guardada até a troca terminar
Var Swapped ; 1 = a versão anterior já saiu do lugar e a nova ainda não entrou

; Desfaz o que estiver pela metade, deixando a versão anterior no lugar.
Function Rollback
  SetOutPath "$TEMP"
  ${If} $Swapped == 1
    ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
      RMDir /r "$INSTDIR"
      Rename "$Backup" "$INSTDIR"
    ${EndIf}
    StrCpy $Swapped 0
  ${EndIf}
  ${If} $Stage != ""
    RMDir /r "$Stage"
  ${EndIf}
FunctionEnd

; Falha: volta ao estado anterior, avisa (se houver janela) e encerra.
!macro Fail MSG
  Call Rollback
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "${MSG}$\r$\n$\r$\nA versão que já estava instalada foi mantida."
  ${EndIf}
  Abort
!macroend

; A cópia nova está inteira? (o executável tem o tamanho certo e o código do app está lá)
Function VerifyStage
  StrCpy $R9 "ok"
  ${IfNot} ${FileExists} "$Stage\resources\app\dist\main.js"
    StrCpy $R9 "faltam arquivos"
  ${EndIf}
  !ifdef EXESIZE
    ClearErrors
    FileOpen $R0 "$Stage\${EXE}" r
    ${If} ${Errors}
      StrCpy $R9 "executável ausente"
    ${Else}
      FileSeek $R0 0 END $R1
      FileClose $R0
      ${If} $R1 != ${EXESIZE}
        StrCpy $R9 "executável incompleto"
      ${EndIf}
    ${EndIf}
  !endif
FunctionEnd

; A versão nova é copiada inteira para uma pasta ao lado, conferida, e só então troca de lugar
; com a anterior. Se qualquer passo falhar, a anterior continua (ou volta) no lugar.
Section "Install"
  StrCpy $Stage "$INSTDIR.new"
  StrCpy $Backup "$INSTDIR.old"
  StrCpy $Swapped 0
  Call CheckSpace
  Call WaitForApp

  ; restos de uma tentativa anterior interrompida
  SetOutPath "$TEMP"
  RMDir /r "$Stage"
  ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
  ${AndIf} ${FileExists} "$Backup\${EXE}"
    RMDir /r "$INSTDIR"
    Rename "$Backup" "$INSTDIR"
  ${EndIf}
  RMDir /r "$Backup"

  ; 1. copia a versão nova ao lado da instalada
  ClearErrors
  SetOutPath "$Stage"
  File /r "${SRC}\*.*"
  WriteUninstaller "$Stage\Desinstalar ${APP}.exe"
  SetOutPath "$TEMP"
  ${If} ${Errors}
    !insertmacro Fail "Não foi possível copiar os arquivos do AriranhaCast (disco cheio ou sem permissão)."
  ${EndIf}

  ; 2. confere
  Call VerifyStage
  ${If} $R9 != "ok"
    !insertmacro Fail "A cópia da nova versão não ficou completa ($R9)."
  ${EndIf}

  ; 3. troca: a anterior sai do lugar, a nova entra
  ${If} ${FileExists} "$INSTDIR\*.*"
    StrCpy $R1 0
    ${Do}
      ClearErrors
      Rename "$INSTDIR" "$Backup"
      ${IfNot} ${Errors}
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 > 20
        !insertmacro Fail "Não foi possível substituir a versão instalada: algum arquivo dela está em uso. Feche o AriranhaCast e tente de novo."
      ${EndIf}
      Sleep 500
    ${Loop}
    StrCpy $Swapped 1
  ${EndIf}
  ClearErrors
  Rename "$Stage" "$INSTDIR"
  ${If} ${Errors}
    !insertmacro Fail "Não foi possível colocar a nova versão no lugar."
  ${EndIf}
  StrCpy $Swapped 0
  RMDir /r "$Backup"

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

; A instalação falhou ou foi cancelada: garante a volta ao estado anterior e, na atualização
; automática (--force-run), reabre a versão que continua instalada.
Function .onInstFailed
  Call Rollback
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
  ${AndIf} ${FileExists} "$INSTDIR\${EXE}"
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; só apaga a pasta se ela for mesmo uma instalação do AriranhaCast
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    RMDir /r "$INSTDIR"
    RMDir /r "$INSTDIR.new"
    RMDir /r "$INSTDIR.old"
  ${EndIf}
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
