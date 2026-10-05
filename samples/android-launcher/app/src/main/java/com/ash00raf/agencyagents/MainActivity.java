package com.ash00raf.agencyagents;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Agency Agents launcher — a native shell around the local web app
 * (Termux serves it at http://localhost:8787). One file, zero external
 * dependencies, deliberately boring: JS + localStorage on (chat history
 * survives), navigations kept in-app, a plain offline page with Retry
 * when the Termux server isn't up, and back-button page history.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "http://localhost:8787/";
    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // conversations + prefs persist
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setBackgroundColor(Color.parseColor("#1e1e28"));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only replace the page for main-frame failures (the server
                // is down) — ignore subresource noise.
                if (Build.VERSION.SDK_INT >= 23 && request != null && !request.isForMainFrame()) {
                    return;
                }
                view.loadData(offlinePage(), "text/html", "utf-8");
            }
        });

        setContentView(web);
        if (savedInstanceState == null) {
            web.loadUrl(APP_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    /** Dark, on-brand offline screen with a Retry button (no assets needed). */
    private static String offlinePage() {
        return "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{background:#1e1e28;color:#e6e6ef;font-family:sans-serif;display:flex;"
            + "flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;"
            + "text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b8b9e;font-size:14px;"
            + "margin:0 0 20px}button{background:#4f46e5;color:#fff;border:0;border-radius:999px;"
            + "padding:10px 26px;font-size:15px;font-weight:600}</style></head><body>"
            + "<h1>Agency Agents</h1>"
            + "<p>The local server isn't running.<br>Start it from the Termux:Widget shortcut, or:<br>"
            + "<code>node web/server.mjs</code></p>"
            + "<button onclick=\"location.href='" + APP_URL + "'\">Retry</button>"
            + "</body></html>";
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
