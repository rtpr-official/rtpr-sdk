package io.rtpr.sdk;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import io.rtpr.sdk.model.Article;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

/**
 * WebSocket client for real-time RTPR press release streaming.
 *
 * <pre>{@code
 * RtprWebSocket ws = new RtprWebSocket.Builder()
 *     .apiKey("your_api_key")
 *     .listener(new RtprWebSocket.Listener() {
 *         public void onArticle(Article article) {
 *             System.out.println(article.getTicker() + ": " + article.getTitle());
 *         }
 *     })
 *     .build();
 *
 * ws.connect(Arrays.asList("AAPL", "TSLA"));
 * }</pre>
 */
public class RtprWebSocket {
    private static final Logger log = Logger.getLogger(RtprWebSocket.class.getName());
    private static final String DEFAULT_WS_URL = "wss://ws.rtpr.io";
    private static final long INITIAL_RECONNECT_DELAY_MS = 1000;
    private static final long MAX_RECONNECT_DELAY_MS = 60000;

    private final String apiKey;
    private final String wsUrl;
    private final boolean autoReconnect;
    private final Listener listener;
    private final Gson gson;
    private final OkHttpClient httpClient;

    private final AtomicReference<WebSocket> wsRef = new AtomicReference<>();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile List<String> tickers;

    private RtprWebSocket(Builder builder) {
        this.apiKey = builder.apiKey;
        this.wsUrl = builder.wsUrl;
        this.autoReconnect = builder.autoReconnect;
        this.listener = builder.listener;
        this.gson = new Gson();
        this.httpClient = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
    }

    /**
     * Connect to the RTPR WebSocket and subscribe to tickers.
     *
     * @param tickers List of ticker symbols, or ["*"] for firehose mode
     */
    public void connect(List<String> tickers) {
        this.tickers = tickers;
        running.set(true);
        openConnection();
    }

    /**
     * Subscribe to additional tickers on an active connection.
     */
    public void subscribe(List<String> tickers) {
        WebSocket ws = wsRef.get();
        if (ws != null) {
            JsonObject msg = new JsonObject();
            msg.addProperty("action", "subscribe");
            msg.add("tickers", gson.toJsonTree(tickers));
            ws.send(msg.toString());
        }
    }

    /**
     * Unsubscribe from tickers.
     */
    public void unsubscribe(List<String> tickers) {
        WebSocket ws = wsRef.get();
        if (ws != null) {
            JsonObject msg = new JsonObject();
            msg.addProperty("action", "unsubscribe");
            msg.add("tickers", gson.toJsonTree(tickers));
            ws.send(msg.toString());
        }
    }

    /**
     * Disconnect and stop auto-reconnection.
     */
    public void disconnect() {
        running.set(false);
        WebSocket ws = wsRef.getAndSet(null);
        if (ws != null) {
            ws.close(1000, "Client disconnect");
        }
    }

    private void openConnection() {
        String url = wsUrl + "?apiKey=" + apiKey;
        Request request = new Request.Builder().url(url).build();

        httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                wsRef.set(webSocket);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                handleMessage(webSocket, text);
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                wsRef.set(null);
                if (listener != null) {
                    listener.onDisconnect(code, reason);
                }
                if (running.get() && autoReconnect) {
                    scheduleReconnect(INITIAL_RECONNECT_DELAY_MS);
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                wsRef.set(null);
                if (listener != null) {
                    listener.onError(t);
                }
                if (running.get() && autoReconnect) {
                    scheduleReconnect(INITIAL_RECONNECT_DELAY_MS);
                }
            }
        });
    }

    private void handleMessage(WebSocket ws, String text) {
        JsonObject message = gson.fromJson(text, JsonObject.class);
        String type = message.has("type") ? message.get("type").getAsString() : "";

        switch (type) {
            case "connected":
                log.info("Connected to RTPR");
                if (listener != null) {
                    listener.onConnect();
                }
                if (tickers != null && !tickers.isEmpty()) {
                    subscribe(tickers);
                }
                break;

            case "subscribed":
                log.info("Subscribed to: " + message.get("tickers"));
                break;

            case "article":
                if (listener != null && message.has("data")) {
                    Article article = gson.fromJson(message.get("data"), Article.class);
                    listener.onArticle(article);
                }
                break;

            case "ping":
                JsonObject pong = new JsonObject();
                pong.addProperty("type", "pong");
                ws.send(pong.toString());
                break;

            case "error":
                String errorMsg = message.has("message")
                        ? message.get("message").getAsString()
                        : "Unknown error";
                log.warning("Server error: " + errorMsg);
                if (listener != null) {
                    listener.onError(new RuntimeException(errorMsg));
                }
                break;

            default:
                log.fine("Unknown message type: " + type);
                break;
        }
    }

    private void scheduleReconnect(long delayMs) {
        long capped = Math.min(delayMs, MAX_RECONNECT_DELAY_MS);
        log.info("Reconnecting in " + capped + "ms...");
        new Thread(() -> {
            try {
                Thread.sleep(capped);
                if (running.get()) {
                    openConnection();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }).start();
    }

    /**
     * Listener interface for WebSocket events.
     */
    public interface Listener {
        default void onConnect() {}
        default void onArticle(Article article) {}
        default void onDisconnect(int code, String reason) {}
        default void onError(Throwable error) {}
    }

    /**
     * Builder for constructing an RtprWebSocket.
     */
    public static class Builder {
        private String apiKey;
        private String wsUrl = DEFAULT_WS_URL;
        private boolean autoReconnect = true;
        private Listener listener;

        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        public Builder wsUrl(String wsUrl) {
            this.wsUrl = wsUrl;
            return this;
        }

        public Builder autoReconnect(boolean autoReconnect) {
            this.autoReconnect = autoReconnect;
            return this;
        }

        public Builder listener(Listener listener) {
            this.listener = listener;
            return this;
        }

        public RtprWebSocket build() {
            if (apiKey == null || apiKey.isEmpty()) {
                throw new IllegalArgumentException("API key is required");
            }
            return new RtprWebSocket(this);
        }
    }
}
