package com.ash00raf.agencycalculator;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.math.BigDecimal;
import java.math.MathContext;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Agency Calculator — built by the Mobile App Builder agent
 * (engineering/engineering-mobile-app-builder: "Ships native-quality apps
 * on iOS and Android, fast").
 *
 * Native-quality, deliberately boring where it counts:
 *  • ONE file, ZERO external dependencies — builds with just the SDK.
 *  • Exact arithmetic on BigDecimal (no float drift): 0.1 + 0.2 = 0.3.
 *  • Real expression engine: tokenizer → shunting-yard → RPN, with
 *    precedence (× ÷ before + −), unary minus, and postfix %.
 *  • Dark, touch-first UI: 5×4 grid, running expression above a live
 *    preview, backspace, auto-scrolling display.
 *  • Fully offline — the manifest declares no permissions at all.
 */
public class MainActivity extends Activity {

    // ── Theme ────────────────────────────────────────────────────────────
    private static final int BG        = Color.parseColor("#1e1e28");
    private static final int KEY_NUM   = Color.parseColor("#2e2e3e");
    private static final int KEY_OP    = Color.parseColor("#3a3a4e");
    private static final int KEY_CLEAR = Color.parseColor("#5b3a6e");
    private static final int ACCENT    = Color.parseColor("#4f46e5");
    private static final int TXT_MAIN  = Color.parseColor("#f2f2f7");
    private static final int TXT_DIM   = Color.parseColor("#8b8b9e");

    // ── State ────────────────────────────────────────────────────────────
    private String expr = "";          // the expression being typed
    private String lastExpression = "";// shown above the result after "="
    private String resultText = "0";   // what the big line shows
    private boolean justEvaluated = false;

    private TextView exprView;         // small line: "12 + 7 ×"
    private TextView resultView;       // big line: live value / result
    private HorizontalScrollView displayScroller;

    // ═══════════════════════════════ UI ══════════════════════════════════

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setPadding(dp(10), dp(28), dp(10), dp(10));

        // Display: small expression line + big auto-scrolled result line.
        exprView = new TextView(this);
        exprView.setTextColor(TXT_DIM);
        exprView.setTextSize(18);
        exprView.setGravity(Gravity.END);
        exprView.setSingleLine(true);
        exprView.setPadding(0, 0, dp(6), 0);

        resultView = new TextView(this);
        resultView.setTextColor(TXT_MAIN);
        resultView.setTextSize(44);
        resultView.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
        resultView.setGravity(Gravity.END);
        resultView.setSingleLine(true);
        resultView.setPadding(0, 0, dp(6), dp(10));

        displayScroller = new HorizontalScrollView(this);
        displayScroller.setHorizontalScrollBarEnabled(false);
        displayScroller.setFillViewport(true);
        displayScroller.addView(resultView);

        LinearLayout display = new LinearLayout(this);
        display.setOrientation(LinearLayout.VERTICAL);
        display.setPadding(dp(8), dp(16), dp(8), dp(8));
        display.addView(exprView);
        display.addView(displayScroller);

        // Keypad: C ⌫ % ÷ / 7 8 9 × / 4 5 6 − / 1 2 3 + / ± 0 . =
        String[][] rows = {
                {"C", "⌫", "%", "÷"},
                {"7", "8", "9", "×"},
                {"4", "5", "6", "−"},
                {"1", "2", "3", "+"},
                {"±", "0", ".", "="},
        };

        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        for (String[] row : rows) {
            LinearLayout line = new LinearLayout(this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            for (String label : row) {
                line.addView(key(label), new LinearLayout.LayoutParams(
                        0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));
            }
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
            lp.setMargins(0, 0, 0, dp(6));
            grid.addView(line, lp);
        }

        root.addView(display, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(grid, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1.15f));

        setContentView(root);
        render();
    }

    /** One styled key, wired to onKey. */
    private Button key(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(TXT_MAIN);
        boolean digit = label.length() == 1 && label.charAt(0) >= '0' && label.charAt(0) <= '9';
        b.setTextSize(digit ? 26 : 22);
        b.setAllCaps(false);

        int bg;
        switch (label) {
            case "=":   bg = ACCENT;    break;
            case "C":   bg = KEY_CLEAR; break;
            case "⌫": case "%": case "÷": case "×": case "−": case "+": case "±":
                bg = KEY_OP; break;
            default:    bg = KEY_NUM;   break; // digits and "."
        }
        b.setBackgroundColor(bg);
        if ("=".equals(label)) b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(0, 0, 0, 0);
        b.setOnClickListener((v) -> onKey(label));
        return b;
    }

    // ═════════════════════════════ Input handling ════════════════════════

    private void onKey(String k) {
        char c = k.isEmpty() ? ' ' : k.charAt(0);

        if (c >= '0' && c <= '9') {
            if (justEvaluated) { expr = ""; lastExpression = ""; justEvaluated = false; }
            expr += k;
        } else if (".".equals(k)) {
            if (justEvaluated) { expr = ""; lastExpression = ""; justEvaluated = false; }
            int start = numberStart(expr);
            if (!expr.substring(start).contains(".")) {
                expr += (start == expr.length()) ? "0." : ".";
            }
        } else if (k.equals("÷") || k.equals("×") || k.equals("−") || k.equals("+")) {
            justEvaluated = false;
            if (expr.isEmpty()) {
                if (k.equals("−")) {
                    expr = "−"; // start negative
                } else {
                    // Chain from the shown value when it's a plain number.
                    String r = resultText.replace("−", "-");
                    expr = (isNumberish(r) ? r : "0") + k;
                }
            } else if (endsWithOperator(expr) && !k.equals("−")) {
                // Replace the trailing binary operator (a following − is unary).
                if (expr.length() >= 2 && endsWithOperator(expr.substring(0, expr.length() - 1))
                        && expr.endsWith("−")) {
                    expr = expr.substring(0, expr.length() - 2) + k; // collapse op+unary
                } else {
                    expr = expr.substring(0, expr.length() - 1) + k;
                }
            } else if (expr.endsWith("−") && k.equals("−") && !endsWithOperator(expr.substring(0, expr.length() - 1))) {
                expr = expr.substring(0, expr.length() - 1) + "+"; // −− → +
            } else {
                expr += k;
            }
        } else if ("%".equals(k)) {
            if (!expr.isEmpty() && !endsWithOperator(expr)) {
                expr += "%";
                justEvaluated = false;
            }
        } else if ("⌫".equals(k)) {
            if (justEvaluated) { expr = ""; lastExpression = ""; justEvaluated = false; }
            else if (!expr.isEmpty()) expr = expr.substring(0, expr.length() - 1);
        } else if ("C".equals(k)) {
            expr = ""; lastExpression = ""; resultText = "0"; justEvaluated = false;
        } else if ("±".equals(k)) {
            justEvaluated = false;
            toggleSign();
        } else if ("=".equals(k)) {
            evaluate();
        }

        render();
    }

    /** Toggle the sign of the trailing number (or seed a negative number). */
    private void toggleSign() {
        int start = numberStart(expr);
        if (start == expr.length()) {
            expr += "−0";
            return;
        }
        String head = expr.substring(0, start);
        String num = expr.substring(start);
        if (num.startsWith("−") || num.startsWith("-")) {
            expr = head + num.substring(1);
        } else {
            expr = head + "−" + num;
        }
    }

    private void evaluate() {
        String cleaned = expr;
        while (!cleaned.isEmpty() && endsWithOperator(cleaned)) {
            cleaned = cleaned.substring(0, cleaned.length() - 1);
        }
        if (cleaned.isEmpty()) return;
        lastExpression = cleaned + " =";
        try {
            BigDecimal value = Eval.evaluate(cleaned);
            if (value == null) {
                resultText = "Can't divide by 0";
                expr = "";
            } else {
                resultText = pretty(Eval.show(value));
                expr = Eval.show(value); // seed chaining: 12 + 7 × …
            }
        } catch (Exception e) {
            resultText = "Error";
            expr = "";
        }
        justEvaluated = true;
    }

    // ═════════════════════════════ Rendering ═════════════════════════════

    private void render() {
        if (justEvaluated) {
            exprView.setText(lastExpression);
        } else {
            exprView.setText(expr.isEmpty() ? " " : pretty(expr));
            // Live preview of the running total (a lone number previews itself).
            String preview = "";
            if (!expr.isEmpty()) {
                try {
                    BigDecimal v = Eval.evaluate(expr);
                    if (v != null) preview = pretty(Eval.show(v));
                } catch (Exception ignore) { /* keep typing */ }
            }
            resultText = preview.isEmpty() ? "0" : preview;
        }
        resultView.setText(resultText);
        displayScroller.post(() -> displayScroller.fullScroll(HorizontalScrollView.FOCUS_RIGHT));
    }

    private static String pretty(String s) {
        return s.replace("-", "−");
    }

    private static boolean isNumberish(String s) {
        if (s == null || s.isEmpty()) return false;
        for (char c : s.toCharArray()) {
            if (!(c >= '0' && c <= '9') && c != '.' && c != '-') return false;
        }
        return true;
    }

    /** Index where the trailing number token starts (== length if none). */
    private static int numberStart(String s) {
        int i = s.length();
        while (i > 0) {
            char c = s.charAt(i - 1);
            if ((c >= '0' && c <= '9') || c == '.') i--;
            else break;
        }
        // A minus attached to that number belongs to it (either glyph).
        if (i > 0 && (s.charAt(i - 1) == '−' || s.charAt(i - 1) == '-')
                && (i - 1 == 0 || isOperator(s.charAt(i - 2)))) {
            i--;
        }
        return i;
    }

    private static boolean endsWithOperator(String s) {
        if (s.isEmpty()) return false;
        char c = s.charAt(s.length() - 1);
        return c == '+' || c == '−' || c == '-' || c == '×' || c == '÷';
    }

    private static boolean isOperator(char c) {
        return c == '+' || c == '−' || c == '-' || c == '×' || c == '÷';
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ═════════════════════════ Expression engine ═════════════════════════
    //
    // Tokens → shunting-yard → RPN → BigDecimal evaluation. No parentheses
    // in the keypad; precedence is × ÷ over + −, unary − binds tightest,
    // % is postfix (÷100 of the operand it follows).

    static final class Eval {

        static BigDecimal evaluate(String expr) {
            List<String> rpn = toRpn(expr);
            if (rpn == null) return null;
            Deque<BigDecimal> st = new ArrayDeque<>();
            for (String t : rpn) {
                switch (t) {
                    case "+": { BigDecimal b = st.pop(), a = st.pop(); st.push(a.add(b)); break; }
                    case "-": { BigDecimal b = st.pop(), a = st.pop(); st.push(a.subtract(b)); break; }
                    case "*": { BigDecimal b = st.pop(), a = st.pop(); st.push(a.multiply(b)); break; }
                    case "/": {
                        BigDecimal b = st.pop(), a = st.pop();
                        if (b.signum() == 0) return null; // divide by zero
                        st.push(a.divide(b, MathContext.DECIMAL64));
                        break;
                    }
                    case "u-": st.push(st.pop().negate()); break;
                    case "%": st.push(st.pop().divide(BigDecimal.valueOf(100), MathContext.DECIMAL64)); break;
                    default: st.push(new BigDecimal(t));
                }
            }
            return st.isEmpty() ? null : st.pop();
        }

        /** Shunting-yard. Input may use − × ÷ glyphs; output uses ASCII ops. */
        private static List<String> toRpn(String expr) {
            List<String> out = new ArrayList<>();
            Deque<String> ops = new ArrayDeque<>();
            boolean mayBeUnary = true;

            for (int i = 0; i < expr.length(); ) {
                char c = expr.charAt(i);
                if ((c >= '0' && c <= '9') || c == '.') {
                    int j = i;
                    while (j < expr.length()
                            && ((expr.charAt(j) >= '0' && expr.charAt(j) <= '9') || expr.charAt(j) == '.')) {
                        j++;
                    }
                    out.add(normalize(expr.substring(i, j)));
                    i = j;
                    mayBeUnary = false;
                    continue;
                }
                if (c == '%') {
                    out.add("%");
                    i++;
                    mayBeUnary = false;
                    continue;
                }
                String op = (c == '+') ? "+" : (c == '−' || c == '-') ? "-" :
                            (c == '×') ? "*" : (c == '÷') ? "/" : null;
                if (op == null) return null; // unexpected character

                if (op.equals("-") && mayBeUnary) {
                    ops.push("u-");
                    i++;
                    continue;
                }
                while (!ops.isEmpty() && prec(ops.peek()) >= prec(op)) {
                    out.add(ops.pop());
                }
                ops.push(op);
                i++;
                mayBeUnary = true;
            }
            while (!ops.isEmpty()) out.add(ops.pop());
            return out;
        }

        private static int prec(String op) {
            switch (op) {
                case "u-": return 3;
                case "*": case "/": return 2;
                default: return 1;
            }
        }

        /** "5." → "5", ".5" → "0.5" so BigDecimal always accepts the token. */
        private static String normalize(String num) {
            if (num.endsWith(".")) num = num.substring(0, num.length() - 1);
            if (num.startsWith(".")) num = "0" + num;
            if (num.isEmpty()) num = "0";
            return num;
        }

        /** Display form: strip trailing zeros, cap length, no exponents. */
        static String show(BigDecimal v) {
            BigDecimal x = v.stripTrailingZeros();
            if (x.scale() < 0) x = x.setScale(0);
            String s = x.toPlainString();
            if (s.replace("-", "").replace(".", "").length() > 16) {
                s = x.round(new MathContext(14)).stripTrailingZeros().toPlainString();
            }
            return s;
        }
    }
}
