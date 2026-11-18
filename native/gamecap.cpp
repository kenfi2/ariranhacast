// gamecap — "Captura de jogo" do AriranhaCast, no mesmo esquema do OBS e do Discord: um módulo
// injetado no jogo copia cada quadro (antes de ir para a tela) para uma textura na placa de vídeo.
// Não tem a borda amarela do Windows, não depende da janela estar visível e custa quase nada.
//
// O módulo injetado é o graphics-hook do próprio OBS Studio (assinado digitalmente pela
// OBS Project, LLC; ver native/obs/LEIA-ME.md). Este programa faz o papel do plugin
// "win-capture" do OBS: injeta o hook com o inject-helper do OBS (modo compatível com
// anti-cheat), conversa com ele pelos objetos nomeados do protocolo e recebe a textura.
//
// Cada quadro é desenhado (já redimensionado) em uma de NSLOTS texturas BGRA compartilhadas por
// handle NT, duplicado para dentro do processo principal do AriranhaCast, que importa a textura
// com o módulo sharedTexture do Electron e entrega o quadro ao WebRTC sem passar pela CPU.
//
//   gamecap --hwnd <HWND> --parent <PID> [--fps 60] [--height 1080] [--obs <pasta>]
//
// Também faz a captura normal (sem hook) SEM o cursor do mouse, pelo mesmo caminho de texturas:
//   gamecap --mode window --hwnd <HWND> --parent <PID> ...   janela, pelo Windows Graphics Capture
//                                                            (cursor e borda amarela desligados)
//   gamecap --mode screen --point <x>,<y> --parent <PID> ... monitor que contém o ponto (pixels
//                                                            físicos), pelo Desktop Duplication (não
//                                                            inclui o cursor)
//
// stdout, uma mensagem por linha:
//   LOG <texto>                         diagnóstico (inclui o log do próprio hook)
//   HOOKED <largura> <altura> <tipo>    capturando (tipo: textura | memoria | janela | tela)
//   TEX <ger> <i> <handle> <w> <h>      textura i da geração ger; handle já vale no processo pai
//   FRAME <ger> <i> <us>                quadro pronto na textura i (us = instante em microssegundos)
//   LOST <motivo>                       o jogo fechou ou parou de ser capturado
//   ERROR <etapa> <detalhe>             falhou (o app volta para a captura normal)
// stdin: "R <ger> <i>" devolve a textura i (o app terminou de usá-la). Fim do stdin = encerrar.
//
// Compilação: ver native/BUILD.md.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <inspectable.h>
#include <mmsystem.h>
#include <ctype.h>
#include <inttypes.h>
#include <stdint.h>
#include <algorithm>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

// ---------------------------------------------------------------------------------------------
// Protocolo do graphics-hook (cópia de obs-studio/shared/obs-hook-config/graphics-hook-info.h,
// versão 1.8.8 do hook, usada no OBS 33.0.1). Não mudar sem conferir o header do OBS.
#define EVENT_CAPTURE_RESTART L"CaptureHook_Restart"
#define EVENT_CAPTURE_STOP L"CaptureHook_Stop"
#define EVENT_HOOK_READY L"CaptureHook_HookReady"
#define EVENT_HOOK_EXIT L"CaptureHook_Exit"
#define EVENT_HOOK_INIT L"CaptureHook_Initialize"
#define WINDOW_HOOK_KEEPALIVE L"CaptureHook_KeepAlive"
#define MUTEX_TEXTURE1 L"CaptureHook_TextureMutex1"
#define MUTEX_TEXTURE2 L"CaptureHook_TextureMutex2"
#define SHMEM_HOOK_INFO L"CaptureHook_HookInfo"
#define SHMEM_TEXTURE L"CaptureHook_Texture"
#define PIPE_NAME "CaptureHook_Pipe"
#define HOOK_VER_MAJOR 1

#pragma pack(push, 8)
struct d3d8_offsets { uint32_t present; };
struct d3d9_offsets { uint32_t present, present_ex, present_swap, d3d9_clsoff, is_d3d9ex_clsoff; };
struct d3d12_offsets { uint32_t execute_command_lists; };
struct dxgi_offsets { uint32_t present, resize, present1; };
struct dxgi_offsets2 { uint32_t release; };
struct ddraw_offsets {
  uint32_t surface_create, surface_restore, surface_release, surface_unlock, surface_blt, surface_flip,
      surface_set_palette, palette_set_entries;
};
struct shmem_data { volatile int last_tex; uint32_t tex1_offset; uint32_t tex2_offset; };
struct shtex_data { uint32_t tex_handle; };
enum capture_type { CAPTURE_TYPE_MEMORY, CAPTURE_TYPE_TEXTURE };
struct graphics_offsets {
  d3d8_offsets d3d8; d3d9_offsets d3d9; dxgi_offsets dxgi; ddraw_offsets ddraw; dxgi_offsets2 dxgi2; d3d12_offsets d3d12;
};
struct hook_info {
  uint32_t hook_ver_major, hook_ver_minor;
  capture_type type;
  uint32_t window, format, cx, cy, UNUSED_base_cx, UNUSED_base_cy, pitch, map_id, map_size;
  bool flip;
  uint64_t frame_interval;
  bool UNUSED_use_scale, force_shmem, capture_overlay, allow_srgb_alias;
  graphics_offsets offsets;
  uint32_t reserved[126];
};
static_assert(sizeof(hook_info) == 648, "ABI do graphics-hook do OBS");
#pragma pack(pop)

// ---------------------------------------------------------------------------------------------
// Saída (várias threads escrevem no stdout)
static CRITICAL_SECTION g_out;
static void out(const char* fmt, ...) {
  char buf[1400];
  va_list ap;
  va_start(ap, fmt);
  int n = _vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
  va_end(ap);
  if (n < 0) n = (int)strlen(buf);
  if (n > (int)sizeof(buf) - 2) n = (int)sizeof(buf) - 2;
  for (int i = 0; i < n; i++)
    if (buf[i] == '\r' || buf[i] == '\n') buf[i] = ' ';
  buf[n++] = '\n';
  EnterCriticalSection(&g_out);
  fwrite(buf, 1, (size_t)n, stdout);
  fflush(stdout);
  LeaveCriticalSection(&g_out);
}
#define LOG(...) out("LOG " __VA_ARGS__)

[[noreturn]] static void die(int code, const char* step, const char* fmt, ...) {
  char buf[600];
  va_list ap;
  va_start(ap, fmt);
  _vsnprintf(buf, sizeof(buf) - 1, fmt, ap);
  buf[sizeof(buf) - 1] = 0;
  va_end(ap);
  out("ERROR %s %s", step, buf);
  ExitProcess((UINT)code);
}

static void close_h(HANDLE* h) {
  if (*h) CloseHandle(*h);
  *h = nullptr;
}

template <class T> static void safe_release(T** p) {
  if (*p) (*p)->Release();
  *p = nullptr;
}

static bool signalled(HANDLE h) { return h && WaitForSingleObject(h, 0) == WAIT_OBJECT_0; }

static void name_id(wchar_t* dst, size_t cap, const wchar_t* base, DWORD id) { _snwprintf(dst, cap, L"%s%lu", base, id); dst[cap - 1] = 0; }

// ---------------------------------------------------------------------------------------------
// Parâmetros e estado global
static HWND g_hwnd = nullptr;
static DWORD g_pid = 0, g_tid = 0, g_parent_pid = 0;
static bool g_is64 = true;
static int g_fps = 60;
static int g_max_h = 0;
static wchar_t g_obs_dir[MAX_PATH] = L"";
enum Mode { MODE_HOOK, MODE_WINDOW, MODE_SCREEN };
static Mode g_mode = MODE_HOOK;
static POINT g_point = {0, 0};  // --mode screen: um ponto do monitor (pixels físicos)
static IDXGIAdapter1* g_adapter = nullptr;  // --mode screen: a placa de vídeo ligada ao monitor
static HANDLE g_parent = nullptr;    // processo do AriranhaCast (para duplicar/fechar handles nele)
static HANDLE g_target = nullptr;    // processo do jogo
static volatile LONG g_quit = 0;

// ---------------------------------------------------------------------------------------------
// Texturas de saída (anel de NSLOTS). O app devolve cada uma com "R <ger> <i>".
static const int NSLOTS = 8;
struct Slot {
  ID3D11Texture2D* tex = nullptr;
  ID3D11RenderTargetView* rtv = nullptr;
  HANDLE local = nullptr;        // handle NT neste processo
  uint64_t remote = 0;           // o mesmo handle, dentro do processo do AriranhaCast
  volatile LONG busy = 0;        // 1 = com o app
};
static Slot g_slots[NSLOTS];
static volatile LONG g_gen = 0;
static int g_out_w = 0, g_out_h = 0;
static int g_next_slot = 0;
// Handles da geração anterior, ainda abertos no processo pai, a fechar quando não houver uso.
static uint64_t g_old_remote[NSLOTS * 4];
static int g_old_count = 0;
static DWORD g_old_since = 0;

static ID3D11Device* g_dev = nullptr;
static ID3D11DeviceContext* g_ctx = nullptr;
static ID3D11VertexShader* g_vs = nullptr;
static ID3D11PixelShader* g_ps = nullptr;
static ID3D11SamplerState* g_sampler = nullptr;
static ID3D11Buffer* g_cbuf = nullptr;
static ID3D11Query* g_query = nullptr;

// Fonte: textura compartilhada do hook ou cópia da memória compartilhada.
static ID3D11Texture2D* g_src = nullptr;
static ID3D11ShaderResourceView* g_src_srv = nullptr;
static bool g_src_linear = false;  // conteúdo em luz linear (scRGB/sRGB): converter para sRGB
static bool g_flip = false;

static void stdin_thread_body() {
  char line[128];
  while (fgets(line, sizeof(line), stdin)) {
    long gen = -1, idx = -1;
    if (line[0] == 'R' && sscanf(line + 1, "%ld %ld", &gen, &idx) == 2 && gen == g_gen && idx >= 0 && idx < NSLOTS)
      InterlockedExchange(&g_slots[idx].busy, 0);
    else if (line[0] == 'Q')
      break;
  }
  InterlockedExchange(&g_quit, 1);
}
static DWORD WINAPI stdin_thread(LPVOID) {
  stdin_thread_body();
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Direct3D 11: dispositivo, shaders (compilados na hora pelo d3dcompiler_47 do Windows)
typedef HRESULT(WINAPI* PFN_D3DCompile)(const void*, SIZE_T, const char*, const void*, void*, const char*, const char*, UINT, UINT,
                                        ID3DBlob**, ID3DBlob**);

static const char kShader[] = R"HLSL(
Texture2D t0 : register(t0);
SamplerState s0 : register(s0);
cbuffer C : register(b0) { float flip; float lin; float2 pad; };
struct V { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
V vs(uint id : SV_VertexID) {
  V o;
  float2 uv = float2((id << 1) & 2, id & 2);
  o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
  o.uv = uv;
  if (flip > 0.5) o.uv.y = 1 - o.uv.y;
  return o;
}
float4 ps(V i) : SV_TARGET {
  float3 c = t0.Sample(s0, i.uv).rgb;
  if (lin > 0.5) {
    c = saturate(c);
    c = (c <= 0.0031308) ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  }
  return float4(c, 1);
}
)HLSL";

static void init_d3d() {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  // Desktop Duplication exige o dispositivo na placa de vídeo do monitor.
  const D3D_DRIVER_TYPE type = g_adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE;
  HRESULT hr = D3D11CreateDevice(g_adapter, type, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 4,
                                 D3D11_SDK_VERSION, &g_dev, nullptr, &g_ctx);
  if (FAILED(hr))  // sem 11.1 (Windows 7/placas antigas) o pedido com 11_1 falha com E_INVALIDARG
    hr = D3D11CreateDevice(g_adapter, type, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels + 1, 3,
                           D3D11_SDK_VERSION, &g_dev, nullptr, &g_ctx);
  if (FAILED(hr)) die(10, "d3d11", "0x%08lx", (unsigned long)hr);

  HMODULE dc = LoadLibraryExW(L"d3dcompiler_47.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  PFN_D3DCompile compile = dc ? (PFN_D3DCompile)GetProcAddress(dc, "D3DCompile") : nullptr;
  if (!compile) die(11, "d3dcompiler", "d3dcompiler_47.dll ausente");
  ID3DBlob *vsb = nullptr, *psb = nullptr, *err = nullptr;
  hr = compile(kShader, sizeof(kShader) - 1, "gamecap", nullptr, nullptr, "vs", "vs_4_0", 0, 0, &vsb, &err);
  if (FAILED(hr)) die(12, "shader", "vs %s", err ? (const char*)err->GetBufferPointer() : "?");
  hr = compile(kShader, sizeof(kShader) - 1, "gamecap", nullptr, nullptr, "ps", "ps_4_0", 0, 0, &psb, &err);
  if (FAILED(hr)) die(12, "shader", "ps %s", err ? (const char*)err->GetBufferPointer() : "?");
  g_dev->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &g_vs);
  g_dev->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &g_ps);
  vsb->Release();
  psb->Release();
  if (!g_vs || !g_ps) die(12, "shader", "criar");

  D3D11_SAMPLER_DESC sd = {};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  sd.MaxLOD = D3D11_FLOAT32_MAX;
  g_dev->CreateSamplerState(&sd, &g_sampler);

  D3D11_BUFFER_DESC bd = {};
  bd.ByteWidth = 16;
  bd.Usage = D3D11_USAGE_DEFAULT;
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  g_dev->CreateBuffer(&bd, nullptr, &g_cbuf);

  D3D11_QUERY_DESC qd = {D3D11_QUERY_EVENT, 0};
  g_dev->CreateQuery(&qd, &g_query);
  if (!g_sampler || !g_cbuf || !g_query) die(10, "d3d11", "recursos");
}

static void close_remote(uint64_t h) {
  if (h && g_parent) DuplicateHandle(g_parent, (HANDLE)(uintptr_t)h, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
}

static void free_slots() {
  for (int i = 0; i < NSLOTS; i++) {
    Slot& s = g_slots[i];
    if (s.remote && g_old_count < (int)(sizeof(g_old_remote) / sizeof(g_old_remote[0]))) g_old_remote[g_old_count++] = s.remote;
    else close_remote(s.remote);
    s.remote = 0;
    close_h(&s.local);
    safe_release(&s.rtv);
    safe_release(&s.tex);
    s.busy = 0;
  }
  g_old_since = GetTickCount();
}

/** Fecha no processo pai os handles da geração anterior, 2 s depois da troca (o app ignora quadros
 *  de gerações antigas e já terá terminado de importar os que estavam a caminho). */
static void reap_old() {
  if (!g_old_count || GetTickCount() - g_old_since < 2000) return;
  for (int i = 0; i < g_old_count; i++) close_remote(g_old_remote[i]);
  g_old_count = 0;
}

static void make_slots(int w, int h) {
  if (w == g_out_w && h == g_out_h && g_slots[0].tex) return;
  free_slots();
  LONG gen = InterlockedIncrement(&g_gen);
  for (int i = 0; i < NSLOTS; i++) {
    Slot& s = g_slots[i];
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = (UINT)w;
    td.Height = (UINT)h;
    td.MipLevels = td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    td.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    HRESULT hr = g_dev->CreateTexture2D(&td, nullptr, &s.tex);
    if (FAILED(hr)) die(13, "textura", "0x%08lx", (unsigned long)hr);
    g_dev->CreateRenderTargetView(s.tex, nullptr, &s.rtv);
    IDXGIResource1* res = nullptr;
    s.tex->QueryInterface(__uuidof(IDXGIResource1), (void**)&res);
    if (!res) die(13, "textura", "IDXGIResource1");
    hr = res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &s.local);
    res->Release();
    if (FAILED(hr)) die(13, "textura", "handle 0x%08lx", (unsigned long)hr);
    HANDLE remote = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), s.local, g_parent, &remote, 0, FALSE, DUPLICATE_SAME_ACCESS))
      die(13, "textura", "duplicar %lu", GetLastError());
    s.remote = (uint64_t)(uintptr_t)remote;
    out("TEX %ld %d %" PRIu64 " %d %d", gen, i, s.remote, w, h);
  }
  g_out_w = w;
  g_out_h = h;
  g_next_slot = 0;
}

static DXGI_FORMAT srv_format(DXGI_FORMAT tex, DXGI_FORMAT hook) {
  switch (tex) {
    case DXGI_FORMAT_R8G8B8A8_TYPELESS: return hook == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB ? DXGI_FORMAT_R8G8B8A8_UNORM : (hook ? hook : DXGI_FORMAT_R8G8B8A8_UNORM);
    case DXGI_FORMAT_B8G8R8A8_TYPELESS: return hook == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB ? DXGI_FORMAT_B8G8R8A8_UNORM : (hook ? hook : DXGI_FORMAT_B8G8R8A8_UNORM);
    case DXGI_FORMAT_B8G8R8X8_TYPELESS: return DXGI_FORMAT_B8G8R8X8_UNORM;
    case DXGI_FORMAT_R10G10B10A2_TYPELESS: return DXGI_FORMAT_R10G10B10A2_UNORM;
    case DXGI_FORMAT_R16G16B16A16_TYPELESS: return DXGI_FORMAT_R16G16B16A16_FLOAT;
    default: return tex;
  }
}

static bool is_linear(DXGI_FORMAT f) {
  return f == DXGI_FORMAT_R16G16B16A16_FLOAT || f == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB || f == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB ||
         f == DXGI_FORMAT_B8G8R8X8_UNORM_SRGB;
}

static void release_src() {
  safe_release(&g_src_srv);
  safe_release(&g_src);
}

static bool make_srv(DXGI_FORMAT hook_fmt) {
  D3D11_TEXTURE2D_DESC d;
  g_src->GetDesc(&d);
  DXGI_FORMAT f = srv_format(d.Format, hook_fmt);
  D3D11_SHADER_RESOURCE_VIEW_DESC vd = {};
  vd.Format = f;
  vd.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
  vd.Texture2D.MipLevels = 1;
  HRESULT hr = g_dev->CreateShaderResourceView(g_src, &vd, &g_src_srv);
  if (FAILED(hr)) {
    LOG("srv falhou formato %d/%d 0x%08lx", (int)d.Format, (int)f, (unsigned long)hr);
    return false;
  }
  g_src_linear = is_linear(f);
  return true;
}

/** Desenha a fonte (redimensionada) na textura i e espera a GPU terminar. */
static bool render_to(int i) {
  Slot& s = g_slots[i];
  float cb[4] = {g_flip ? 1.f : 0.f, g_src_linear ? 1.f : 0.f, 0, 0};
  g_ctx->UpdateSubresource(g_cbuf, 0, nullptr, cb, 0, 0);
  D3D11_VIEWPORT vp = {0, 0, (float)g_out_w, (float)g_out_h, 0, 1};
  g_ctx->RSSetViewports(1, &vp);
  g_ctx->OMSetRenderTargets(1, &s.rtv, nullptr);
  g_ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  g_ctx->IASetInputLayout(nullptr);
  g_ctx->VSSetShader(g_vs, nullptr, 0);
  g_ctx->VSSetConstantBuffers(0, 1, &g_cbuf);
  g_ctx->PSSetShader(g_ps, nullptr, 0);
  g_ctx->PSSetConstantBuffers(0, 1, &g_cbuf);
  g_ctx->PSSetShaderResources(0, 1, &g_src_srv);
  g_ctx->PSSetSamplers(0, 1, &g_sampler);
  g_ctx->Draw(3, 0);
  ID3D11ShaderResourceView* none = nullptr;
  g_ctx->PSSetShaderResources(0, 1, &none);
  g_ctx->OMSetRenderTargets(0, nullptr, nullptr);
  g_ctx->End(g_query);
  g_ctx->Flush();
  // O Chromium lê a textura em outro dispositivo: só avisamos depois que a cópia terminou.
  DWORD start = GetTickCount();
  while (g_ctx->GetData(g_query, nullptr, 0, 0) == S_FALSE) {
    if (GetTickCount() - start > 100) return false;
    SwitchToThread();
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Arquivos do OBS
static void obs_file(wchar_t* dst, const wchar_t* base, bool b64, const wchar_t* ext) {
  _snwprintf(dst, MAX_PATH, L"%s\\%s%s%s", g_obs_dir, base, b64 ? L"64" : L"32", ext);
  dst[MAX_PATH - 1] = 0;
}

/** Roda um programa do OBS sem janela e devolve o código de saída (e o stdout, se pedido). */
static bool run_helper(const wchar_t* exe, const wchar_t* args, char* outbuf, size_t outcap, DWORD timeout_ms, DWORD* code,
                       HANDLE* async_proc) {
  wchar_t cmd[2048];
  _snwprintf(cmd, 2048, L"\"%s\" %s", exe, args);
  cmd[2047] = 0;
  SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
  HANDLE rd = nullptr, wr = nullptr;
  if (outbuf) {
    if (!CreatePipe(&rd, &wr, &sa, 0)) return false;
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
  }
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  if (outbuf) {
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = wr;
    si.hStdError = wr;
  }
  PROCESS_INFORMATION pi = {};
  BOOL ok = CreateProcessW(exe, cmd, nullptr, nullptr, outbuf ? TRUE : FALSE, CREATE_NO_WINDOW, nullptr, g_obs_dir, &si, &pi);
  if (wr) CloseHandle(wr);
  if (!ok) {
    close_h(&rd);
    return false;
  }
  CloseHandle(pi.hThread);
  if (async_proc) {
    *async_proc = pi.hProcess;
    close_h(&rd);
    return true;
  }
  size_t got = 0;
  if (outbuf) {
    DWORD n = 0;
    while (got + 1 < outcap && ReadFile(rd, outbuf + got, (DWORD)(outcap - 1 - got), &n, nullptr) && n) got += n;
    outbuf[got] = 0;
    close_h(&rd);
  }
  if (WaitForSingleObject(pi.hProcess, timeout_ms) != WAIT_OBJECT_0) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hProcess);
    return false;
  }
  DWORD c = 1;
  GetExitCodeProcess(pi.hProcess, &c);
  CloseHandle(pi.hProcess);
  if (code) *code = c;
  return true;
}

/** Endereços das funções gráficas do sistema (o hook precisa deles), via get-graphics-offsets. */
static graphics_offsets load_offsets(bool b64) {
  graphics_offsets o = {};
  wchar_t exe[MAX_PATH];
  obs_file(exe, L"get-graphics-offsets", b64, L".exe");
  static char text[8192];
  DWORD code = 1;
  if (!run_helper(exe, L"", text, sizeof(text), 15000, &code, nullptr)) die(20, "offsets", "não rodou");
  char section[32] = "";
  for (char* line = strtok(text, "\r\n"); line; line = strtok(nullptr, "\r\n")) {
    if (line[0] == '[') {
      sscanf(line, "[%31[^]]", section);
      continue;
    }
    char key[64];
    unsigned long v = 0;
    const char* eq = strchr(line, '=');
    if (!eq || eq - line >= (ptrdiff_t)sizeof(key)) continue;
    memcpy(key, line, (size_t)(eq - line));
    key[eq - line] = 0;
    v = strtoul(eq + 1, nullptr, 0);
    if (!strcmp(section, "d3d8") && !strcmp(key, "present")) o.d3d8.present = v;
    else if (!strcmp(section, "d3d9")) {
      if (!strcmp(key, "present")) o.d3d9.present = v;
      else if (!strcmp(key, "present_ex")) o.d3d9.present_ex = v;
      else if (!strcmp(key, "present_swap")) o.d3d9.present_swap = v;
      else if (!strcmp(key, "d3d9_clsoff")) o.d3d9.d3d9_clsoff = v;
      else if (!strcmp(key, "is_d3d9ex_clsoff")) o.d3d9.is_d3d9ex_clsoff = v;
    } else if (!strcmp(section, "dxgi")) {
      if (!strcmp(key, "present")) o.dxgi.present = v;
      else if (!strcmp(key, "present1")) o.dxgi.present1 = v;
      else if (!strcmp(key, "resize")) o.dxgi.resize = v;
      else if (!strcmp(key, "release")) o.dxgi2.release = v;
    }
  }
  if (!o.dxgi.present) LOG("offsets: sem dxgi (código %lu)", code);
  return o;
}

// ---------------------------------------------------------------------------------------------
// Log do hook (pipe nomeado; o hook escreve mensagens terminadas em \0)
static DWORD WINAPI pipe_thread(LPVOID) {
  char name[96];
  _snprintf(name, sizeof(name), "\\\\.\\pipe\\%s%lu", PIPE_NAME, g_pid);
  name[sizeof(name) - 1] = 0;
  SECURITY_DESCRIPTOR sd;
  InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
  SetSecurityDescriptorDacl(&sd, TRUE, nullptr, FALSE);  // como o OBS: o jogo pode rodar com outro nível de integridade
  SECURITY_ATTRIBUTES sa = {sizeof(sa), &sd, FALSE};
  for (;;) {
    HANDLE p = CreateNamedPipeA(name, PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 1024, 1024, 0, &sa);
    if (p == INVALID_HANDLE_VALUE) return 0;
    if (ConnectNamedPipe(p, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
      char buf[1025];
      DWORD n = 0;
      for (;;) {
        BOOL ok = ReadFile(p, buf, 1024, &n, nullptr);
        if (!ok && GetLastError() != ERROR_MORE_DATA) break;
        buf[n] = 0;
        if (n) LOG("hook: %s", buf);
      }
    }
    CloseHandle(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Conversa com o hook (espelha plugins/win-capture/game-capture.c do OBS)
struct Hook {
  HANDLE keepalive = nullptr;
  HANDLE restart = nullptr, stop = nullptr, init = nullptr, ready = nullptr, exit = nullptr;
  HANDLE mutex[2] = {nullptr, nullptr};
  HANDLE info_map = nullptr;
  hook_info* info = nullptr;
  HANDLE data_map = nullptr;
  void* data = nullptr;
  HANDLE injector = nullptr;
  bool active = false;     // objetos abertos e "init" sinalizado
  bool capturing = false;  // recebendo quadros
  bool force_shmem = false;
  capture_type type = CAPTURE_TYPE_TEXTURE;
  uint32_t cx = 0, cy = 0, pitch = 0, format = 0;
  ID3D11Texture2D* shm_tex = nullptr;  // modo memória: cópia na GPU
};
static Hook g;
static graphics_offsets g_offsets;

static HANDLE open_ev(const wchar_t* base) {
  wchar_t n[64];
  name_id(n, 64, base, g_pid);
  return OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, n);
}

static void stop_capture(bool tell_hook) {
  if (tell_hook && g.stop) SetEvent(g.stop);
  if (g.info) UnmapViewOfFile(g.info);
  g.info = nullptr;
  if (g.data) UnmapViewOfFile(g.data);
  g.data = nullptr;
  close_h(&g.data_map);
  close_h(&g.info_map);
  close_h(&g.restart);
  close_h(&g.stop);
  close_h(&g.init);
  close_h(&g.ready);
  close_h(&g.exit);
  close_h(&g.mutex[0]);
  close_h(&g.mutex[1]);
  safe_release(&g.shm_tex);
  release_src();
  if (g.capturing) out("LOST parou");
  g.active = false;
  g.capturing = false;
}

static bool try_open_hook() {
  wchar_t n[64];
  name_id(n, 64, MUTEX_TEXTURE1, g_pid);
  g.mutex[0] = OpenMutexW(SYNCHRONIZE, FALSE, n);
  name_id(n, 64, MUTEX_TEXTURE2, g_pid);
  g.mutex[1] = OpenMutexW(SYNCHRONIZE, FALSE, n);
  if (!g.mutex[0] || !g.mutex[1]) {
    close_h(&g.mutex[0]);
    close_h(&g.mutex[1]);
    return false;  // hook ainda não carregou
  }
  name_id(n, 64, SHMEM_HOOK_INFO, g_pid);
  g.info_map = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, n);
  if (!g.info_map) return false;
  g.info = (hook_info*)MapViewOfFile(g.info_map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(hook_info));
  if (!g.info) return false;
  g.info->offsets = g_offsets;
  g.info->capture_overlay = false;
  g.info->force_shmem = g.force_shmem;
  g.info->UNUSED_use_scale = false;
  g.info->allow_srgb_alias = true;
  // O hook copia no máximo nesta cadência (metade do intervalo, como o OBS sem limitar): o jogo não perde desempenho à toa.
  g.info->frame_interval = 1000000000ULL / (uint64_t)g_fps / 2;
  if (!g.restart) g.restart = open_ev(EVENT_CAPTURE_RESTART);
  g.stop = open_ev(EVENT_CAPTURE_STOP);
  g.init = open_ev(EVENT_HOOK_INIT);
  g.ready = open_ev(EVENT_HOOK_READY);
  g.exit = open_ev(EVENT_HOOK_EXIT);
  if (!g.restart || !g.stop || !g.init || !g.ready || !g.exit) return false;
  SetEvent(g.init);
  g.active = true;
  return true;
}

static void inject() {
  wchar_t helper[MAX_PATH], dll[MAX_PATH], args[MAX_PATH + 64];
  obs_file(helper, L"inject-helper", g_is64, L".exe");
  obs_file(dll, L"graphics-hook", g_is64, L".dll");
  if (GetFileAttributesW(helper) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW(dll) == INVALID_FILE_ATTRIBUTES)
    die(21, "arquivos", "faltam os arquivos do OBS");
  // "1" = injeção segura (SetWindowsHookEx na thread da janela), a compatível com anti-cheat do OBS.
  _snwprintf(args, MAX_PATH + 64, L"\"%s\" 1 %lu", dll, g_tid);
  args[MAX_PATH + 63] = 0;
  if (!run_helper(helper, args, nullptr, 0, 0, nullptr, &g.injector)) die(22, "injetar", "inject-helper não rodou (%lu)", GetLastError());
  LOG("injetando (modo compatível com anti-cheat)");
}

static bool open_data_map(HWND w) {
  wchar_t base[64], n[96];
  _snwprintf(base, 64, SHMEM_TEXTURE L"_%" PRIu64 L"_", (uint64_t)(uintptr_t)w);
  base[63] = 0;
  name_id(n, 96, base, g.info->map_id);
  g.data_map = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, n);
  return !!g.data_map;
}

static void fit_size(uint32_t cx, uint32_t cy, int* w, int* h) {
  int oh = (int)cy, ow = (int)cx;
  if (g_max_h > 0 && oh > g_max_h) {
    ow = (int)((double)cx * g_max_h / cy + 0.5);
    oh = g_max_h;
  }
  *w = std::max(2, ow & ~1);
  *h = std::max(2, oh & ~1);
}

/** O hook avisou que está pronto (primeira vez ou depois de o jogo mudar de resolução). */
static bool start_capture() {
  if (g.info->hook_ver_major > HOOK_VER_MAJOR) {
    LOG("versão do hook não suportada: %u.%u", g.info->hook_ver_major, g.info->hook_ver_minor);
    return false;
  }
  if (g.data) UnmapViewOfFile(g.data);
  g.data = nullptr;
  close_h(&g.data_map);
  if (!open_data_map(g_hwnd) && !open_data_map((HWND)(uintptr_t)g.info->window)) {
    LOG("mapa de dados indisponível (%lu)", GetLastError());
    return false;
  }
  g.data = MapViewOfFile(g.data_map, FILE_MAP_ALL_ACCESS, 0, 0, g.info->map_size);
  if (!g.data) return false;
  g.type = g.info->type;
  g.cx = g.info->cx;
  g.cy = g.info->cy;
  g.pitch = g.info->pitch;
  g.format = g.info->format;
  g_flip = g.info->flip;
  release_src();
  safe_release(&g.shm_tex);
  if (g.type == CAPTURE_TYPE_TEXTURE) {
    HANDLE h = (HANDLE)(uintptr_t)((shtex_data*)g.data)->tex_handle;
    HRESULT hr = g_dev->OpenSharedResource(h, __uuidof(ID3D11Texture2D), (void**)&g_src);
    if (FAILED(hr)) {
      // Jogo em outra placa de vídeo (notebook com duas GPUs): pede ao hook a cópia pela memória.
      LOG("textura do jogo em outra GPU (0x%08lx); usando memória compartilhada", (unsigned long)hr);
      g.force_shmem = true;
      return false;
    }
    if (!make_srv((DXGI_FORMAT)g.format)) return false;
  } else {
    DXGI_FORMAT f = (DXGI_FORMAT)g.format;
    if (f == DXGI_FORMAT_B5G5R5A1_UNORM || f == DXGI_FORMAT_B5G6R5_UNORM) {
      LOG("formato de 16 bits não suportado");
      return false;
    }
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = g.cx;
    td.Height = g.cy;
    td.MipLevels = td.ArraySize = 1;
    td.Format = f;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(g_dev->CreateTexture2D(&td, nullptr, &g.shm_tex))) {
      LOG("textura de memória falhou (formato %d)", (int)f);
      return false;
    }
    g_src = g.shm_tex;
    g_src->AddRef();
    if (!make_srv(f)) return false;
  }
  int w, h;
  fit_size(g.cx, g.cy, &w, &h);
  make_slots(w, h);
  out("HOOKED %u %u %s", g.cx, g.cy, g.type == CAPTURE_TYPE_TEXTURE ? "textura" : "memoria");
  return true;
}

/** Modo memória: copia o último quadro que o hook deixou na memória compartilhada. */
static void upload_shmem() {
  shmem_data* d = (shmem_data*)g.data;
  int cur = d->last_tex;
  if (cur < 0 || cur > 1) return;
  int other = cur == 1 ? 0 : 1;
  HANDLE m = nullptr;
  if (signalled(g.mutex[cur])) m = g.mutex[cur];
  else if (signalled(g.mutex[other])) {
    m = g.mutex[other];
    cur = other;
  } else return;
  uint8_t* px = (uint8_t*)g.data + (cur == 0 ? d->tex1_offset : d->tex2_offset);
  g_ctx->UpdateSubresource(g.shm_tex, 0, nullptr, px, g.pitch, 0);
  ReleaseMutex(m);
}

// ---------------------------------------------------------------------------------------------
static const char* kBlocked[] = {"explorer", "steam", "steamwebhelper", "battle.net", "galaxyclient", "skype", "uplay", "origin",
                                 "devenv", "taskmgr", "chrome", "msedge", "firefox", "opera", "brave", "discord", "obs64",
                                 "obs32", "ariranhacast", "systemsettings", "applicationframehost", "cmd", "shellexperiencehost",
                                 "searchui", "lockapp", "searchhost", "startmenuexperiencehost", nullptr};

static void check_target() {
  g_tid = GetWindowThreadProcessId(g_hwnd, &g_pid);
  if (!g_tid || !g_pid) die(30, "janela", "não existe mais");
  if (g_pid == GetCurrentProcessId() || g_pid == g_parent_pid) die(30, "janela", "própria");
  g_target = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, g_pid);
  if (!g_target) die(31, "processo", "sem acesso (%lu) — o jogo roda como administrador?", GetLastError());
  wchar_t path[MAX_PATH];
  DWORD n = MAX_PATH;
  char exe[MAX_PATH] = "";
  if (QueryFullProcessImageNameW(g_target, 0, path, &n)) {
    const wchar_t* base = wcsrchr(path, L'\\');
    base = base ? base + 1 : path;
    WideCharToMultiByte(CP_UTF8, 0, base, -1, exe, MAX_PATH, nullptr, nullptr);
  }
  char low[MAX_PATH];
  size_t i = 0;
  for (; exe[i] && i + 1 < sizeof(low); i++) low[i] = (char)tolower((unsigned char)exe[i]);
  low[i] = 0;
  if (char* dot = strrchr(low, '.')) *dot = 0;
  for (const char** b = kBlocked; *b; b++)
    if (!strcmp(low, *b)) die(32, "bloqueado", "%s não é um jogo", exe);
  BOOL wow = FALSE;
  IsWow64Process(g_target, &wow);
  g_is64 = !wow;
  LOG("alvo %s pid %lu %s", exe, g_pid, g_is64 ? "64 bits" : "32 bits");
}


// ---------------------------------------------------------------------------------------------
// Captura sem cursor (sem hook): janela pelo Windows Graphics Capture, tela pelo Desktop
// Duplication. O Chromium sempre desenha o cursor por cima das capturas dele; aqui o quadro chega
// limpo e segue pelo mesmo anel de texturas da captura de jogo.
//
// Interfaces WinRT declaradas à mão (o MinGW do zig não traz windows.graphics.capture.h). UUIDs e
// ordem dos métodos conferidos com windows.graphics.capture.idl do mingw-w64.
struct SizeInt32 { int32_t Width, Height; };
struct IGraphicsCaptureSession;
struct IDirect3D11CaptureFrame : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE get_Surface(IInspectable** v) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_SystemRelativeTime(int64_t* v) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_ContentSize(SizeInt32* v) = 0;
};
struct IGraphicsCaptureItem : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE get_DisplayName(void** v) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_Size(SizeInt32* v) = 0;
  virtual HRESULT STDMETHODCALLTYPE add_Closed(void* h, int64_t* token) = 0;
  virtual HRESULT STDMETHODCALLTYPE remove_Closed(int64_t token) = 0;
};
struct IDirect3D11CaptureFramePool : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE Recreate(IInspectable* device, int32_t format, int32_t buffers, SizeInt32 size) = 0;
  virtual HRESULT STDMETHODCALLTYPE TryGetNextFrame(IDirect3D11CaptureFrame** frame) = 0;
  virtual HRESULT STDMETHODCALLTYPE add_FrameArrived(void* h, int64_t* token) = 0;
  virtual HRESULT STDMETHODCALLTYPE remove_FrameArrived(int64_t token) = 0;
  virtual HRESULT STDMETHODCALLTYPE CreateCaptureSession(IGraphicsCaptureItem* item, IGraphicsCaptureSession** session) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_DispatcherQueue(void** v) = 0;
};
struct IDirect3D11CaptureFramePoolStatics2 : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE CreateFreeThreaded(IInspectable* device, int32_t format, int32_t buffers, SizeInt32 size,
                                                       IDirect3D11CaptureFramePool** pool) = 0;
};
struct IGraphicsCaptureSession : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE StartCapture() = 0;
};
struct IGraphicsCaptureSession2 : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE get_IsCursorCaptureEnabled(boolean* v) = 0;
  virtual HRESULT STDMETHODCALLTYPE put_IsCursorCaptureEnabled(boolean v) = 0;
};
struct IGraphicsCaptureSession3 : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE get_IsBorderRequired(boolean* v) = 0;
  virtual HRESULT STDMETHODCALLTYPE put_IsBorderRequired(boolean v) = 0;
};
struct IGraphicsCaptureItemInterop : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE CreateForWindow(HWND window, REFIID riid, void** result) = 0;
  virtual HRESULT STDMETHODCALLTYPE CreateForMonitor(HMONITOR monitor, REFIID riid, void** result) = 0;
};
struct IDirect3DDxgiInterfaceAccess : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID iid, void** p) = 0;
};
struct IClosable : IInspectable {
  virtual HRESULT STDMETHODCALLTYPE Close() = 0;
};

static const GUID IID_IGraphicsCaptureItem_ = {0x79c3f95b, 0x31f7, 0x4ec2, {0xa4, 0x64, 0x63, 0x2e, 0xf5, 0xd3, 0x07, 0x60}};
static const GUID IID_IGraphicsCaptureItemInterop_ = {0x3628e81b, 0x3cac, 0x4c60, {0xb7, 0xf4, 0x23, 0xce, 0x0e, 0x0c, 0x33, 0x56}};
static const GUID IID_IDirect3D11CaptureFramePoolStatics2_ = {0x589b103f, 0x6bbc, 0x5df5, {0xa9, 0x91, 0x02, 0xe2, 0x8b, 0x3b, 0x66, 0xd5}};
static const GUID IID_IGraphicsCaptureSession2_ = {0x2c39ae40, 0x7d2e, 0x5044, {0x80, 0x4e, 0x8b, 0x67, 0x99, 0xd4, 0xcf, 0x9e}};
static const GUID IID_IGraphicsCaptureSession3_ = {0xf2cdd966, 0x22ae, 0x5ea1, {0x95, 0x96, 0x3a, 0x28, 0x93, 0x44, 0xc3, 0xbe}};
static const GUID IID_IDirect3DDxgiInterfaceAccess_ = {0xa9b3d012, 0x3df2, 0x4ee3, {0xb8, 0xd1, 0x86, 0x95, 0xf4, 0x57, 0xd3, 0xc1}};
static const GUID IID_IClosable_ = {0x30d5a829, 0x7fa4, 0x4026, {0x83, 0xbb, 0xd7, 0x5b, 0xae, 0x4e, 0xa9, 0x9e}};
static const int32_t PIXEL_B8G8R8A8 = 87;  // DirectXPixelFormat.B8G8R8A8UIntNormalized

typedef HRESULT(WINAPI* PFN_RoInitialize)(int);
typedef HRESULT(WINAPI* PFN_WindowsCreateString)(const wchar_t*, UINT32, void**);
typedef HRESULT(WINAPI* PFN_WindowsDeleteString)(void*);
typedef HRESULT(WINAPI* PFN_RoGetActivationFactory)(void*, REFIID, void**);
typedef HRESULT(WINAPI* PFN_CreateD3DDevice)(IDXGIDevice*, IInspectable**);

static IGraphicsCaptureItem* w_item = nullptr;
static IDirect3D11CaptureFramePool* w_pool = nullptr;
static IGraphicsCaptureSession* w_session = nullptr;
static IInspectable* w_device = nullptr;
static SizeInt32 w_size = {0, 0};
static IDXGIOutputDuplication* d_dup = nullptr;
static IDXGIOutput1* d_output = nullptr;
static int g_src_w = 0, g_src_h = 0;

static void close_winrt(IInspectable* p) {
  if (!p) return;
  IClosable* c = nullptr;
  if (SUCCEEDED(p->QueryInterface(IID_IClosable_, (void**)&c)) && c) {
    c->Close();
    c->Release();
  }
}

/** Fonte própria (cópia do quadro capturado) no tamanho w×h. */
static bool ensure_src(int w, int h) {
  if (g_src && g_src_w == w && g_src_h == h) return true;
  release_src();
  D3D11_TEXTURE2D_DESC td = {};
  td.Width = (UINT)w;
  td.Height = (UINT)h;
  td.MipLevels = td.ArraySize = 1;
  td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DEFAULT;
  td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  if (FAILED(g_dev->CreateTexture2D(&td, nullptr, &g_src))) return false;
  if (!make_srv(DXGI_FORMAT_B8G8R8A8_UNORM)) return false;
  g_src_w = w;
  g_src_h = h;
  g_flip = false;
  int ow, oh;
  fit_size((uint32_t)w, (uint32_t)h, &ow, &oh);
  make_slots(ow, oh);
  return true;
}

static void start_window_capture() {
  HMODULE combase = LoadLibraryExW(L"combase.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  HMODULE d3d = GetModuleHandleW(L"d3d11.dll");
  auto roInit = combase ? (PFN_RoInitialize)GetProcAddress(combase, "RoInitialize") : nullptr;
  auto mkStr = combase ? (PFN_WindowsCreateString)GetProcAddress(combase, "WindowsCreateString") : nullptr;
  auto delStr = combase ? (PFN_WindowsDeleteString)GetProcAddress(combase, "WindowsDeleteString") : nullptr;
  auto factory = combase ? (PFN_RoGetActivationFactory)GetProcAddress(combase, "RoGetActivationFactory") : nullptr;
  auto mkDevice = d3d ? (PFN_CreateD3DDevice)GetProcAddress(d3d, "CreateDirect3D11DeviceFromDXGIDevice") : nullptr;
  if (!roInit || !mkStr || !delStr || !factory || !mkDevice) die(40, "wgc", "Windows sem Graphics Capture");
  roInit(1 /* RO_INIT_MULTITHREADED */);

  auto get_factory = [&](const wchar_t* cls, REFIID iid, void** outp) -> HRESULT {
    void* name = nullptr;
    HRESULT hr = mkStr(cls, (UINT32)wcslen(cls), &name);
    if (FAILED(hr)) return hr;
    hr = factory(name, iid, outp);
    delStr(name);
    return hr;
  };

  IGraphicsCaptureItemInterop* interop = nullptr;
  HRESULT hr = get_factory(L"Windows.Graphics.Capture.GraphicsCaptureItem", IID_IGraphicsCaptureItemInterop_, (void**)&interop);
  if (FAILED(hr) || !interop) die(41, "wgc", "fábrica do item 0x%08lx", (unsigned long)hr);
  hr = interop->CreateForWindow(g_hwnd, IID_IGraphicsCaptureItem_, (void**)&w_item);
  interop->Release();
  if (FAILED(hr) || !w_item) die(42, "wgc", "janela não capturável 0x%08lx", (unsigned long)hr);
  w_item->get_Size(&w_size);
  if (w_size.Width <= 0 || w_size.Height <= 0) w_size = {2, 2};

  IDXGIDevice* dxgi = nullptr;
  g_dev->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgi);
  hr = dxgi ? mkDevice(dxgi, &w_device) : E_NOINTERFACE;
  safe_release(&dxgi);
  if (FAILED(hr) || !w_device) die(43, "wgc", "dispositivo 0x%08lx", (unsigned long)hr);

  IDirect3D11CaptureFramePoolStatics2* statics = nullptr;
  hr = get_factory(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool", IID_IDirect3D11CaptureFramePoolStatics2_, (void**)&statics);
  if (FAILED(hr) || !statics) die(44, "wgc", "fábrica do pool 0x%08lx", (unsigned long)hr);
  hr = statics->CreateFreeThreaded(w_device, PIXEL_B8G8R8A8, 2, w_size, &w_pool);
  statics->Release();
  if (FAILED(hr) || !w_pool) die(45, "wgc", "pool 0x%08lx", (unsigned long)hr);
  hr = w_pool->CreateCaptureSession(w_item, &w_session);
  if (FAILED(hr) || !w_session) die(46, "wgc", "sessão 0x%08lx", (unsigned long)hr);

  // Sem cursor (Windows 10 2004+). Sem ele o pedido é de "sem cursor", então não adianta seguir.
  IGraphicsCaptureSession2* s2 = nullptr;
  if (FAILED(w_session->QueryInterface(IID_IGraphicsCaptureSession2_, (void**)&s2)) || !s2)
    die(47, "wgc", "este Windows não deixa tirar o cursor da captura (precisa do Windows 10 2004 ou mais novo)");
  s2->put_IsCursorCaptureEnabled(0);
  s2->Release();
  // Sem a borda amarela (Windows 11; no 10 o Windows ignora).
  IGraphicsCaptureSession3* s3 = nullptr;
  if (SUCCEEDED(w_session->QueryInterface(IID_IGraphicsCaptureSession3_, (void**)&s3)) && s3) {
    s3->put_IsBorderRequired(0);
    s3->Release();
  }
  hr = w_session->StartCapture();
  if (FAILED(hr)) die(48, "wgc", "iniciar 0x%08lx", (unsigned long)hr);
  LOG("captura de janela sem cursor (WGC) %dx%d", w_size.Width, w_size.Height);
}

/** Pega o quadro mais novo (se houver) e copia para g_src. false = nenhum quadro novo. */
static bool poll_window() {
  IDirect3D11CaptureFrame* frame = nullptr;
  IDirect3D11CaptureFrame* next = nullptr;
  // Esvazia a fila: só interessa o mais recente.
  while (SUCCEEDED(w_pool->TryGetNextFrame(&next)) && next) {
    safe_release(&frame);
    frame = next;
    next = nullptr;
  }
  if (!frame) return false;
  SizeInt32 cs = {0, 0};
  frame->get_ContentSize(&cs);
  bool ok = false;
  IInspectable* surface = nullptr;
  IDirect3DDxgiInterfaceAccess* access = nullptr;
  ID3D11Texture2D* tex = nullptr;
  if (SUCCEEDED(frame->get_Surface(&surface)) && surface &&
      SUCCEEDED(surface->QueryInterface(IID_IDirect3DDxgiInterfaceAccess_, (void**)&access)) && access &&
      SUCCEEDED(access->GetInterface(__uuidof(ID3D11Texture2D), (void**)&tex)) && tex) {
    D3D11_TEXTURE2D_DESC d;
    tex->GetDesc(&d);
    int w = std::min<int>(std::max(2, cs.Width), (int)d.Width) & ~1;
    int h = std::min<int>(std::max(2, cs.Height), (int)d.Height) & ~1;
    if (w >= 2 && h >= 2 && ensure_src(w, h)) {
      D3D11_BOX box = {0, 0, 0, (UINT)w, (UINT)h, 1};
      g_ctx->CopySubresourceRegion(g_src, 0, 0, 0, 0, tex, 0, &box);
      ok = true;
    }
  }
  safe_release(&tex);
  safe_release(&access);
  safe_release(&surface);
  close_winrt(frame);
  frame->Release();
  // A janela mudou de tamanho: recria o pool no tamanho novo (o próximo quadro já vem certo).
  if (cs.Width > 0 && cs.Height > 0 && (cs.Width != w_size.Width || cs.Height != w_size.Height)) {
    w_size = cs;
    w_pool->Recreate(w_device, PIXEL_B8G8R8A8, 2, w_size);
  }
  return ok;
}

static void stop_window_capture() {
  close_winrt(w_session);
  safe_release(&w_session);
  close_winrt(w_pool);
  safe_release(&w_pool);
  safe_release(&w_item);
  close_winrt(w_device);
  safe_release(&w_device);
}

/** Acha o monitor do ponto e a placa de vídeo dele (o dispositivo D3D precisa ser criado nela). */
static void find_output() {
  HMONITOR mon = MonitorFromPoint(g_point, MONITOR_DEFAULTTOPRIMARY);
  IDXGIFactory1* f = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&f)) || !f) die(50, "tela", "DXGI indisponível");
  IDXGIAdapter1* a = nullptr;
  for (UINT ai = 0; !d_output && f->EnumAdapters1(ai, &a) != DXGI_ERROR_NOT_FOUND; ai++) {
    IDXGIOutput* o = nullptr;
    for (UINT oi = 0; a->EnumOutputs(oi, &o) != DXGI_ERROR_NOT_FOUND; oi++) {
      DXGI_OUTPUT_DESC od;
      if (SUCCEEDED(o->GetDesc(&od)) && od.Monitor == mon && SUCCEEDED(o->QueryInterface(__uuidof(IDXGIOutput1), (void**)&d_output))) {
        g_adapter = a;
        a->AddRef();
        o->Release();
        break;
      }
      o->Release();
    }
    a->Release();
  }
  f->Release();
  if (!d_output) die(51, "tela", "monitor não encontrado");
}

static bool open_duplication() {
  safe_release(&d_dup);
  HRESULT hr = d_output->DuplicateOutput(g_dev, &d_dup);
  if (FAILED(hr)) {
    LOG("DuplicateOutput 0x%08lx", (unsigned long)hr);
    return false;
  }
  DXGI_OUTDUPL_DESC dd;
  d_dup->GetDesc(&dd);
  if (dd.Rotation != DXGI_MODE_ROTATION_IDENTITY && dd.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) LOG("monitor girado: a imagem sai girada");
  return true;
}

/** Desktop Duplication: copia o quadro novo (se houver) para g_src. A imagem não traz o cursor. */
static bool poll_screen() {
  if (!d_dup && !open_duplication()) return false;
  DXGI_OUTDUPL_FRAME_INFO info;
  IDXGIResource* res = nullptr;
  HRESULT hr = d_dup->AcquireNextFrame(0, &info, &res);
  if (hr == DXGI_ERROR_WAIT_TIMEOUT) return false;
  if (FAILED(hr)) {
    // Troca de resolução, tela do UAC, jogo em tela cheia exclusiva assumindo: abre de novo depois.
    if (hr != DXGI_ERROR_ACCESS_LOST) LOG("AcquireNextFrame 0x%08lx", (unsigned long)hr);
    safe_release(&d_dup);
    return false;
  }
  bool ok = false;
  ID3D11Texture2D* tex = nullptr;
  if (info.LastPresentTime.QuadPart != 0 && SUCCEEDED(res->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&tex)) && tex) {
    D3D11_TEXTURE2D_DESC d;
    tex->GetDesc(&d);
    if (d.Format == DXGI_FORMAT_B8G8R8A8_UNORM && ensure_src((int)d.Width & ~1, (int)d.Height & ~1)) {
      D3D11_BOX box = {0, 0, 0, (UINT)g_src_w, (UINT)g_src_h, 1};
      g_ctx->CopySubresourceRegion(g_src, 0, 0, 0, 0, tex, 0, &box);
      ok = true;
    } else if (d.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
      LOG("formato da tela não suportado: %d", (int)d.Format);
    }
  }
  safe_release(&tex);
  safe_release(&res);
  d_dup->ReleaseFrame();
  return ok;
}

/** Laço da captura sem hook: um quadro por tique (o último, se a imagem não mudou). */
static int run_plain() {
  if (g_mode == MODE_WINDOW) start_window_capture();
  else if (!open_duplication()) die(52, "tela", "o Windows recusou duplicar a tela");

  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, 0x2 /* CREATE_WAITABLE_TIMER_HIGH_RESOLUTION */, TIMER_ALL_ACCESS);
  if (!timer) {
    timeBeginPeriod(1);
    timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);
  }
  LARGE_INTEGER due;
  due.QuadPart = -(10000000LL / g_fps);
  SetWaitableTimer(timer, &due, (LONG)std::max(1, 1000 / g_fps), nullptr, nullptr, FALSE);
  LARGE_INTEGER freq, now;
  QueryPerformanceFrequency(&freq);
  DWORD started = GetTickCount();
  bool hooked = false;

  while (!g_quit) {
    WaitForSingleObject(timer, 100);
    if (g_quit) break;
    if (g_mode == MODE_WINDOW && !IsWindow(g_hwnd)) {
      out("LOST a janela fechou");
      break;
    }
    reap_old();
    bool fresh = g_mode == MODE_WINDOW ? poll_window() : poll_screen();
    if (fresh && !hooked) {
      hooked = true;
      out("HOOKED %d %d %s", g_src_w, g_src_h, g_mode == MODE_WINDOW ? "janela" : "tela");
    }
    if (!hooked) {
      // Janela minimizada não entrega quadro: só desiste se nunca chegou nenhum.
      if (GetTickCount() - started > 8000) die(53, "tempo", "nenhum quadro em 8 s (janela minimizada?)");
      continue;
    }
    if (!g_src_srv) continue;
    int slot = -1;
    for (int k = 0; k < NSLOTS; k++) {
      int i = (g_next_slot + k) % NSLOTS;
      if (!g_slots[i].busy) {
        slot = i;
        break;
      }
    }
    if (slot < 0) continue;
    if (!render_to(slot)) continue;
    InterlockedExchange(&g_slots[slot].busy, 1);
    g_next_slot = (slot + 1) % NSLOTS;
    QueryPerformanceCounter(&now);
    out("FRAME %ld %d %" PRIu64, g_gen, slot, (uint64_t)(now.QuadPart / (freq.QuadPart / 1000000 ? freq.QuadPart / 1000000 : 1)));
  }
  if (g_mode == MODE_WINDOW) stop_window_capture();
  safe_release(&d_dup);
  safe_release(&d_output);
  release_src();
  free_slots();
  for (int i = 0; i < g_old_count; i++) close_remote(g_old_remote[i]);
  return 0;
}

static void parse_args() {
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i + 1 < argc; i += 2) {
    const wchar_t* k = argv[i];
    const wchar_t* v = argv[i + 1];
    if (!wcscmp(k, L"--hwnd")) g_hwnd = (HWND)(uintptr_t)_wcstoui64(v, nullptr, 10);
    else if (!wcscmp(k, L"--parent")) g_parent_pid = wcstoul(v, nullptr, 10);
    else if (!wcscmp(k, L"--fps")) g_fps = std::min(240, std::max(1, (int)wcstol(v, nullptr, 10)));
    else if (!wcscmp(k, L"--height")) g_max_h = std::min(4320, std::max(0, (int)wcstol(v, nullptr, 10)));
    else if (!wcscmp(k, L"--obs")) wcsncpy(g_obs_dir, v, MAX_PATH - 1);
    else if (!wcscmp(k, L"--mode")) g_mode = !wcscmp(v, L"window") ? MODE_WINDOW : !wcscmp(v, L"screen") ? MODE_SCREEN : MODE_HOOK;
    else if (!wcscmp(k, L"--point")) {
      wchar_t* end = nullptr;
      g_point.x = (LONG)wcstol(v, &end, 10);
      g_point.y = end && *end == L',' ? (LONG)wcstol(end + 1, nullptr, 10) : 0;
    }
  }
  if (!g_obs_dir[0]) {
    GetModuleFileNameW(nullptr, g_obs_dir, MAX_PATH);
    if (wchar_t* s = wcsrchr(g_obs_dir, L'\\')) wcscpy(s, L"\\obs");
  }
  if (argv) LocalFree(argv);
  if (g_mode != MODE_SCREEN && (!g_hwnd || !IsWindow(g_hwnd))) die(2, "args", "--hwnd inválido");
  if (!g_parent_pid) die(2, "args", "--parent ausente");
}

int main() {
  InitializeCriticalSection(&g_out);
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  parse_args();
  g_parent = OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, g_parent_pid);
  if (!g_parent) die(3, "pai", "OpenProcess %lu", GetLastError());
  if (g_mode != MODE_HOOK) {
    // Desktop Duplication recusa processos sem DPI por monitor (e o WGC mede a janela certa assim).
    typedef BOOL(WINAPI * PFN_SetDpiCtx)(HANDLE);
    if (auto set = (PFN_SetDpiCtx)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"))
      set((HANDLE)-4 /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */);
    if (g_mode == MODE_SCREEN) find_output();
    init_d3d();
    CreateThread(nullptr, 0, stdin_thread, nullptr, 0, nullptr);
    return run_plain();
  }
  check_target();
  init_d3d();
  g_offsets = load_offsets(g_is64);

  CreateThread(nullptr, 0, stdin_thread, nullptr, 0, nullptr);

  // Enquanto este mutex existir, o hook continua copiando quadros (se este programa morrer, o
  // hook para sozinho em até 5 s).
  wchar_t n[64];
  name_id(n, 64, WINDOW_HOOK_KEEPALIVE, g_pid);
  g.keepalive = CreateMutexW(nullptr, FALSE, n);
  if (!g.keepalive) die(23, "keepalive", "%lu", GetLastError());
  CreateThread(nullptr, 0, pipe_thread, nullptr, 0, nullptr);

  // Hook já carregado (de uma transmissão anterior)? Só pede para recomeçar; senão, injeta.
  g.restart = open_ev(EVENT_CAPTURE_RESTART);
  if (g.restart) {
    LOG("hook já presente no jogo");
    SetEvent(g.restart);
  } else {
    inject();
  }

  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, 0x2 /* CREATE_WAITABLE_TIMER_HIGH_RESOLUTION */, TIMER_ALL_ACCESS);
  if (!timer) {
    timeBeginPeriod(1);
    timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);
  }
  const int64_t period_100ns = 10000000LL / g_fps;
  LARGE_INTEGER due;
  due.QuadPart = -period_100ns;
  SetWaitableTimer(timer, &due, (LONG)std::max<int64_t>(1, 1000 / g_fps), nullptr, nullptr, FALSE);

  LARGE_INTEGER freq, now;
  QueryPerformanceFrequency(&freq);
  DWORD started = GetTickCount();
  DWORD last_try = 0;
  bool ever = false;
  int fails = 0;

  while (!g_quit) {
    WaitForSingleObject(timer, 100);
    if (g_quit) break;
    if (signalled(g_target)) {
      out("LOST o jogo fechou");
      break;
    }
    if (!IsWindow(g_hwnd)) {
      out("LOST a janela fechou");
      break;
    }
    reap_old();

    if (g.injector && signalled(g.injector)) {
      DWORD code = 0;
      GetExitCodeProcess(g.injector, &code);
      close_h(&g.injector);
      if (code != 0) die(24, "injetar", "o inject-helper falhou (código %ld) — anti-cheat ou permissão?", (long)code);
    }

    if (!g.active) {
      DWORD t = GetTickCount();
      if (t - last_try >= 200) {
        last_try = t;
        if (!try_open_hook()) stop_capture(false);  // ainda carregando: fecha o que abriu pela metade
      }
    }

    if (g.active && signalled(g.stop)) {
      // (o próprio hook se reinicia, por exemplo depois de o jogo mudar de resolução)
      LOG("o hook parou a captura");
      stop_capture(false);
    }

    if (g.active && signalled(g.ready)) {
      if (start_capture()) {
        g.capturing = true;
        ever = true;
        fails = 0;
      } else {
        // Tenta de novo (talvez agora pela memória compartilhada).
        stop_capture(true);
        if (++fails >= 4) die(25, "captura", "o hook não entregou a imagem");
        g.restart = open_ev(EVENT_CAPTURE_RESTART);
        if (g.restart) SetEvent(g.restart);
      }
    }

    if (!ever && GetTickCount() - started > 15000)
      die(26, "tempo", "o jogo não apresentou quadros em 15 s (DirectX 9-12/OpenGL; Vulkan exige o OBS instalado)");

    if (!g.capturing || !g_src_srv) continue;
    if (g.type == CAPTURE_TYPE_MEMORY) upload_shmem();

    // próxima textura livre
    int slot = -1;
    for (int k = 0; k < NSLOTS; k++) {
      int i = (g_next_slot + k) % NSLOTS;
      if (!g_slots[i].busy) {
        slot = i;
        break;
      }
    }
    if (slot < 0) continue;  // o app está atrasado: pula este quadro
    if (!render_to(slot)) continue;
    InterlockedExchange(&g_slots[slot].busy, 1);
    g_next_slot = (slot + 1) % NSLOTS;
    QueryPerformanceCounter(&now);
    out("FRAME %ld %d %" PRIu64, g_gen, slot, (uint64_t)(now.QuadPart / (freq.QuadPart / 1000000 ? freq.QuadPart / 1000000 : 1)));
  }

  stop_capture(true);
  free_slots();
  for (int i = 0; i < g_old_count; i++) close_remote(g_old_remote[i]);
  close_h(&g.keepalive);
  return 0;
}
