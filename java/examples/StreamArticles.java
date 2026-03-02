import io.rtpr.sdk.RtprWebSocket;
import io.rtpr.sdk.model.Article;

import java.util.Arrays;

/**
 * Stream real-time press releases via WebSocket.
 */
public class StreamArticles {
    public static void main(String[] args) {
        RtprWebSocket ws = new RtprWebSocket.Builder()
                .apiKey("your_api_key")
                .listener(new RtprWebSocket.Listener() {
                    @Override
                    public void onConnect() {
                        System.out.println("Connected to RTPR real-time feed");
                    }

                    @Override
                    public void onArticle(Article article) {
                        System.out.printf("[%s] %s%n", article.getTicker(), article.getTitle());
                        System.out.printf("  Source: %s%n", article.getAuthor());
                        System.out.printf("  Body:   %s...%n%n",
                                article.getArticleBody().substring(0, Math.min(120, article.getArticleBody().length())));
                    }

                    @Override
                    public void onDisconnect(int code, String reason) {
                        System.out.printf("Disconnected (code=%d): %s%n", code, reason);
                    }

                    @Override
                    public void onError(Throwable error) {
                        System.err.println("Error: " + error.getMessage());
                    }
                })
                .build();

        // Subscribe to specific tickers, or use Arrays.asList("*") for firehose
        ws.connect(Arrays.asList("AAPL", "TSLA", "NVDA", "MSFT"));

        // Keep the program running
        try {
            Thread.sleep(Long.MAX_VALUE);
        } catch (InterruptedException e) {
            ws.disconnect();
        }
    }
}
