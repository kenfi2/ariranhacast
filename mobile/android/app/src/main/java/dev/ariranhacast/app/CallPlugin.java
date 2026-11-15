package dev.ariranhacast.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
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
}
