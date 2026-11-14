// audiocap — captura o áudio de UM aplicativo (ou de tudo, menos um aplicativo) no Windows
// usando WASAPI process loopback (Windows 10 2004+), e escreve PCM cru no stdout:
// 48 kHz, estéreo, 16 bits, little-endian.
//
//   audiocap --include-hwnd <HWND decimal>   áudio do processo dono da janela (e filhos)
//   audiocap --include-pid  <PID>            áudio do processo (e filhos)
//   audiocap --exclude-pid  <PID>            áudio do sistema, menos o processo (e filhos)
//
// stderr: "READY" quando a captura começou, ou "ERROR <etapa> <hresult>".
// Sai quando o stdout fecha (o AriranhaCast encerrou a transmissão) ou o processo-alvo termina.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Declarações do audioclientactivationparams.h (ausente em alguns SDKs/toolchains).
enum LC_LOOPBACK_MODE { LC_INCLUDE_TREE = 0, LC_EXCLUDE_TREE = 1 };
struct LC_LOOPBACK_PARAMS { DWORD TargetProcessId; LC_LOOPBACK_MODE ProcessLoopbackMode; };
enum LC_ACTIVATION_TYPE { LC_ACTIVATION_DEFAULT = 0, LC_ACTIVATION_PROCESS_LOOPBACK = 1 };
struct LC_ACTIVATION_PARAMS { LC_ACTIVATION_TYPE ActivationType; LC_LOOPBACK_PARAMS ProcessLoopbackParams; };
static const wchar_t* kProcessLoopbackDevice = L"VAD\\Process_Loopback";

static const IID kIID_IAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

static int fail(const char* step, HRESULT hr) {
  fprintf(stderr, "ERROR %s 0x%08lx\n", step, (unsigned long)hr);
  fflush(stderr);
  return 1;
}

// Handler de conclusão da ativação. Precisa ser "agile" (IAgileObject) porque o
// Windows o chama de uma thread própria.
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivateHandler() : refs_(1), done_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}
  virtual ~ActivateHandler() { CloseHandle(done_); }
  HANDLE done() const { return done_; }

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
        riid == kIID_IAgileObject) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done_);
    return S_OK;
  }

 private:
  LONG refs_;
  HANDLE done_;
};

int main(int argc, char** argv) {
  if (argc != 3) {
    fprintf(stderr, "uso: audiocap --include-hwnd <hwnd> | --include-pid <pid> | --exclude-pid <pid>\n");
    return 2;
  }
  DWORD pid = 0;
  LC_LOOPBACK_MODE mode = LC_INCLUDE_TREE;
  unsigned long long value = strtoull(argv[2], nullptr, 10);
  if (strcmp(argv[1], "--include-hwnd") == 0) {
    GetWindowThreadProcessId((HWND)(UINT_PTR)value, &pid);
    if (!pid) return fail("hwnd", E_INVALIDARG);
  } else if (strcmp(argv[1], "--include-pid") == 0) {
    pid = (DWORD)value;
  } else if (strcmp(argv[1], "--exclude-pid") == 0) {
    pid = (DWORD)value;
    mode = LC_EXCLUDE_TREE;
  } else {
    return 2;
  }

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("coinit", hr);

  // 1. Ativa um IAudioClient no dispositivo virtual de process loopback.
  LC_ACTIVATION_PARAMS params = {};
  params.ActivationType = LC_ACTIVATION_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;
  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = (BYTE*)&params;

  ActivateHandler* handler = new ActivateHandler();
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  hr = ActivateAudioInterfaceAsync(kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, handler, &op);
  if (FAILED(hr)) return fail("activate", hr);
  if (WaitForSingleObject(handler->done(), 5000) != WAIT_OBJECT_0) return fail("activate-timeout", E_FAIL);

  HRESULT activateHr = E_FAIL;
  IUnknown* unknown = nullptr;
  hr = op->GetActivateResult(&activateHr, &unknown);
  if (FAILED(hr)) return fail("activate-result", hr);
  if (FAILED(activateHr) || !unknown) return fail("activate-result", activateHr);
  IAudioClient* client = nullptr;
  hr = unknown->QueryInterface(__uuidof(IAudioClient), (void**)&client);
  if (FAILED(hr)) return fail("audioclient", hr);

  // 2. Formato fixo; o Windows converte a partir do que o aplicativo estiver tocando.
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000 /* 20 ms */, 0, &fmt, nullptr);
  if (FAILED(hr)) return fail("initialize", hr);

  HANDLE packet = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(packet);
  if (FAILED(hr)) return fail("event", hr);
  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (FAILED(hr)) return fail("capture-service", hr);
  hr = client->Start();
  if (FAILED(hr)) return fail("start", hr);

  fprintf(stderr, "READY\n");
  fflush(stderr);

  // 3. Laço de captura → stdout.
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE target = mode == LC_INCLUDE_TREE ? OpenProcess(SYNCHRONIZE, FALSE, pid) : nullptr;
  static BYTE silence[48000 * 4 / 10]; // até 100 ms de zeros
  for (;;) {
    WaitForSingleObject(packet, 200);
    UINT32 frames = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&frames)) && frames > 0) {
      BYTE* data = nullptr;
      DWORD bufferFlags = 0;
      hr = capture->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr);
      if (FAILED(hr)) return fail("get-buffer", hr);
      DWORD bytes = frames * fmt.nBlockAlign;
      const BYTE* src = data;
      if (bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) {
        if (bytes > sizeof(silence)) bytes = sizeof(silence);
        src = silence;
      }
      DWORD written = 0;
      BOOL ok = WriteFile(out, src, bytes, &written, nullptr);
      capture->ReleaseBuffer(frames);
      if (!ok) return 0; // o AriranhaCast fechou o pipe
    }
    if (target && WaitForSingleObject(target, 0) == WAIT_OBJECT_0) return 3; // aplicativo fechou
  }
}
