package com.bokyapps.bokydo.testing;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.CookieManager;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.util.Collections;

/** A deliberately local-only external browser for the disposable matrix OAuth fixture. */
public final class FixtureBrowserActivity extends Activity {
    private static final String TAG = "BokyDoMatrixBrowser";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView status;
    private boolean stopped;
    private long deadline;

    // LoginPage uses React-controlled TextFields. Use the native input setter and bubbled
    // events, then click the real form submit button; ConsentPage's real Allow button follows.
    private static final String AUTOMATE =
        "(function(){if(location.origin!=='http://127.0.0.1:18090')return 'blocked';"
        + "var p=document.querySelector('input[type=password]');"
        + "if(p){var f=p.closest('form');if(!f)return 'waiting';"
        + "var u=f.querySelector('input[autocomplete~=username]');"
        + "if(!u||f.dataset.matrixSubmitted)return 'waiting';"
        + "var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"
        + "set.call(u,'widget-fixture');u.dispatchEvent(new Event('input',{bubbles:true}));"
        + "set.call(p,'violin-pancake-orbit-meadow');p.dispatchEvent(new Event('input',{bubbles:true}));"
        + "var b=Array.from(f.querySelectorAll('button')).find(x=>x.textContent.trim()==='Sign in');"
        + "if(b&&!b.disabled){f.dataset.matrixSubmitted='true';setTimeout(()=>b.click(),50);return 'signing-in';}"
        + "return 'waiting';}"
        + "var a=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='Allow');"
        + "if(a&&!a.disabled&&!a.dataset.matrixSubmitted){"
        + "var who=Array.from(document.querySelectorAll('p')).find(x=>x.textContent.trim().startsWith('Signed in as '));"
        + "if(!who||!who.querySelector('strong'))return 'waiting';"
        + "if(!who.querySelector('strong').textContent)return 'waiting';"
        + "if(who.querySelector('strong').textContent!=='widget-fixture')return 'wrong-account';"
        + "a.dataset.matrixSubmitted='true';a.click();return 'allowing';}"
        + "return 'waiting';})()";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!"ranchu".equals(Build.HARDWARE) && !"goldfish".equals(Build.HARDWARE)) {
            throw new SecurityException("Disposable emulator required");
        }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setFitsSystemWindows(true);
        status = new TextView(this);
        status.setPadding(16, 16, 16, 16);
        layout.addView(status);
        webView = new WebView(this);
        layout.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return navigate(request.getUrl(), request.isForMainFrame());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return navigate(Uri.parse(url), true);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isFixture(request.getUrl())) return null;
                handler.post(() -> fail("Refused a resource outside the local fixture."));
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
                    Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) fail("The local fixture page could not be loaded.");
            }
        });
        CookieManager.getInstance().removeAllCookies(ignored -> open(getIntent()));
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        open(intent);
    }

    private static boolean isFixture(Uri uri) {
        return uri != null && "http".equals(uri.getScheme())
            && "127.0.0.1:18090".equals(uri.getEncodedAuthority());
    }

    private static boolean isNativeCallback(Uri uri) {
        return uri != null && "com.bokyapps.bokydo".equals(uri.getScheme())
            && uri.getEncodedAuthority() == null && "/oauth2redirect".equals(uri.getEncodedPath())
            && uri.getFragment() == null;
    }

    private void open(Intent intent) {
        handler.removeCallbacksAndMessages(null);
        stopped = false;
        Uri uri = intent == null ? null : intent.getData();
        if (isNativeCallback(uri)) {
            forwardCallback(uri);
        } else if (isFixture(uri)) {
            status.setText("Fixture browser: local OAuth flow");
            deadline = android.os.SystemClock.uptimeMillis() + 90000;
            webView.loadUrl(uri.toString());
            handler.postDelayed(automate, 400);
        } else {
            fail("Refused URL: only the local matrix fixture and native callback are allowed.");
        }
    }

    private boolean navigate(Uri uri, boolean mainFrame) {
        if (isFixture(uri)) return false;
        if (mainFrame && isNativeCallback(uri)) forwardCallback(uri);
        else fail("Refused navigation outside the local fixture.");
        return true;
    }

    private void forwardCallback(Uri uri) {
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        try {
            Intent redirect = new Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .setPackage("com.bokyapps.bokydo");
            startActivity(redirect);
            Log.i(TAG, "Forwarded native OAuth callback to the release app.");
            finish();
        } catch (RuntimeException error) {
            fail("Could not open the release app's native OAuth callback.");
        }
    }

    private final Runnable automate = new Runnable() {
        @Override public void run() {
            if (stopped) return;
            if (android.os.SystemClock.uptimeMillis() >= deadline) {
                fail("Timed out waiting for the local OAuth flow.");
                return;
            }
            webView.evaluateJavascript(AUTOMATE, result -> {
                if (stopped) return;
                if ("\"blocked\"".equals(result) || "\"wrong-account\"".equals(result)) {
                    fail("Refused automation outside the local fixture account.");
                    return;
                }
                if ("\"signing-in\"".equals(result)) status.setText("Fixture browser: submitting fixture sign in");
                if ("\"allowing\"".equals(result)) status.setText("Fixture browser: approving native OAuth consent");
                handler.postDelayed(this, 400);
            });
        }
    };

    private void fail(String message) {
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        if (webView != null) webView.stopLoading();
        status.setText("Fixture browser failed: " + message);
        // Never include a URI, page body, exception message, authorization code, or token.
        Log.e(TAG, message);
    }

    @Override public void onDestroy() {
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
