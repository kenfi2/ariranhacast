package dev.ariranhacast.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Window;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/**
 * Ponte com o Android para a chamada: mantém o app vivo com a tela apagada (serviço em primeiro
 * plano) e escolhe entre alto-falante e fone de ouvido/auricular.
 */
@CapacitorPlugin(name = "Call")
public class CallPlugin extends Plugin {

    private boolean fullscreen = false;

    /** Com o vídeo em tela cheia, o botão voltar só sai da tela cheia (avisa a página). */
    // Registrado ao entrar na tela cheia: o último registrado tem prioridade sobre o do Capacitor.
    private final OnBackPressedCallback backExitsFullscreen = new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
            notifyListeners("fullscreenExit", new JSObject());
        }
    };

    /**
     * Tela cheia de verdade (modo imersivo): esconde a barra de status e a de navegação (voltam
     * por um instante ao deslizar da borda), usa a área do entalhe da câmera e gira para paisagem.
     */
    @PluginMethod
    public void fullscreen(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            fullscreen = on;
            applyFullscreen();
            backExitsFullscreen.remove();
            Activity a = getActivity();
            if (on && a instanceof AppCompatActivity) {
                ((AppCompatActivity) a).getOnBackPressedDispatcher().addCallback((AppCompatActivity) a, backExitsFullscreen);
            }
        });
        call.resolve();
    }

    private void applyFullscreen() {
        Activity a = getActivity();
        Window w = a.getWindow();
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
        if (fullscreen) {
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = fullscreen
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            w.setAttributes(lp);
        }
        a.setRequestedOrientation(fullscreen ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    /** Ao voltar de outro app o Android pode reexibir as barras: reaplica o modo imersivo. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (fullscreen) getActivity().runOnUiThread(this::applyFullscreen);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4711);
        }
        Intent i = new Intent(ctx, CallService.class);
        i.putExtra("text", call.getString("text", "Em uma sala"));
        try {
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Não foi possível manter a chamada em segundo plano: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, CallService.class));
        setSpeakerInternal(false, true);
        call.resolve();
    }

    /** on = alto-falante; off = auricular (ou o fone/Bluetooth conectado). */
    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        boolean ok = setSpeakerInternal(on, false);
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("headset", hasHeadset());
        call.resolve(r);
    }

    /** Mantém a tela acesa (enquanto assiste a uma transmissão). */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("headset", hasHeadset());
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(r);
    }

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private boolean hasHeadset() {
        AudioManager am = audio();
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || t == AudioDeviceInfo.TYPE_USB_HEADSET || (Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET)) {
                return true;
            }
        }
        return false;
    }

    private boolean setSpeakerInternal(boolean on, boolean reset) {
        AudioManager am = audio();
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                if (reset || !on) {
                    am.clearCommunicationDevice();
                    return true;
                }
                List<AudioDeviceInfo> devs = am.getAvailableCommunicationDevices();
                for (AudioDeviceInfo d : devs) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return am.setCommunicationDevice(d);
                }
                return false;
            }
            am.setSpeakerphoneOn(on && !reset);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ---------- login (conta) ----------

    /** Abre o login (https) no navegador do sistema. Nunca abre outro tipo de link. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith("https://")) {
            call.reject("url inválida");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Link ariranhacast:// que abriu o app (se o app estava fechado). Entregue uma vez só. */
    @PluginMethod
    public void takeLaunchLink(PluginCall call) {
        JSObject r = new JSObject();
        Intent intent = getActivity().getIntent();
        String data = intent != null ? intent.getDataString() : null;
        if (data != null && data.startsWith("ariranhacast://")) {
            r.put("url", data);
            intent.setData(null);
        }
        call.resolve(r);
    }

    /** O navegador devolveu o login (ariranhacast://auth?...) ou abriu um convite com o app aberto. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String data = intent != null ? intent.getDataString() : null;
        if (data == null || !data.startsWith("ariranhacast://")) return;
        JSObject o = new JSObject();
        o.put("url", data);
        notifyListeners("appLink", o, true);
    }

    // ---------- atualização do APK ----------
    // A página consulta o latest-android.json da última release e, se houver versão nova, pede
    // para baixar: o APK é conferido pelo SHA-256 antes de abrir o instalador do Android (que só
    // aceita se a assinatura for a mesma do app instalado).

    private static final long MAX_APK = 300L * 1024 * 1024;
    private volatile boolean downloading = false;

    private static HttpURLConnection open(String url) throws Exception {
        if (url == null || !url.startsWith("https://")) throw new Exception("url inválida");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true); // a GitHub redireciona para o servidor de arquivos (https → https)
        c.setRequestProperty("User-Agent", "AriranhaCast-Android");
        int code = c.getResponseCode();
        if (code != 200) throw new Exception("HTTP " + code);
        return c;
    }

    /** Baixa um texto pequeno (o latest-android.json). Feito aqui porque a página não tem CORS para a GitHub. */
    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url");
        new Thread(() -> {
            try {
                HttpURLConnection c = open(url);
                try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        if (out.size() > 64 * 1024) throw new Exception("resposta grande demais");
                    }
                    JSObject r = new JSObject();
                    r.put("text", new String(out.toByteArray(), StandardCharsets.UTF_8));
                    call.resolve(r);
                } finally {
                    c.disconnect();
                }
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** Baixa o APK, confere o SHA-256 e abre o instalador do Android. */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url");
        String sha = call.getString("sha256", "");
        if (sha == null || !sha.matches("^[0-9a-f]{64}$")) {
            call.reject("sha256 inválido");
            return;
        }
        Context ctx = getContext();
        // Android 8+: o usuário precisa permitir que o AriranhaCast instale apps (uma vez só).
        if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.reject("Permita \"Instalar apps desconhecidos\" para o AriranhaCast e toque em Atualizar de novo.", "NEEDS_PERMISSION");
            return;
        }
        if (downloading) {
            call.reject("O download já está em andamento.");
            return;
        }
        downloading = true;
        new Thread(() -> {
            File dir = new File(ctx.getCacheDir(), "updates");
            File apk = new File(dir, "AriranhaCast.apk");
            try {
                dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                HttpURLConnection c = open(url);
                long total = c.getContentLengthLong();
                if (total > MAX_APK) throw new Exception("arquivo grande demais");
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long done = 0;
                int lastPct = -1;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        done += n;
                        if (done > MAX_APK) throw new Exception("arquivo grande demais");
                        int pct = total > 0 ? (int) (done * 100 / total) : -1;
                        if (pct != lastPct) {
                            lastPct = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            notifyListeners("updateProgress", p);
                        }
                    }
                } finally {
                    c.disconnect();
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format("%02x", b));
                if (!hex.toString().equals(sha)) throw new Exception("o arquivo baixado não confere (SHA-256 diferente)");

                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                call.resolve();
            } catch (Exception e) {
                apk.delete();
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                downloading = false;
            }
        }).start();
    }
}
