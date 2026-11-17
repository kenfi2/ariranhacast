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
import android.view.Window;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
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
}
