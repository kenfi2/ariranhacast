package dev.ariranhacast.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Serviço em primeiro plano durante a chamada: impede o Android de encerrar o app (e o áudio)
 * com a tela apagada, e segura o Wi-Fi em modo de baixa latência para a voz não picotar.
 */
public class CallService extends Service {
    private static final String CHANNEL = "call";
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Chamada", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "Em uma sala";
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("AriranhaCast")
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        int type = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            boolean mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            type = mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        }
        try {
            ServiceCompat.startForeground(this, 1, n, type);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ariranhacast:call");
            wake.setReferenceCounted(false);
            wake.acquire(6 * 60 * 60 * 1000L);
        }
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifi = wm.createWifiLock(mode, "ariranhacast:call");
            wifi.setReferenceCounted(false);
            wifi.acquire();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null;
        wifi = null;
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // O usuário fechou o app pela lista de recentes: encerra a chamada junto.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
