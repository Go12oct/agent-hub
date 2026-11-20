package tech.agenthub.app;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup.MarginLayoutParams;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        View webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            MarginLayoutParams params = (MarginLayoutParams) view.getLayoutParams();
            params.leftMargin = bars.left;
            params.topMargin = bars.top;
            params.rightMargin = bars.right;
            params.bottomMargin = Math.max(bars.bottom, ime.bottom);
            view.setLayoutParams(params);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
    }
}
