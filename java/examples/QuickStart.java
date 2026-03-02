import io.rtpr.sdk.RtprClient;
import io.rtpr.sdk.model.Article;

import java.util.List;

/**
 * Quickstart: fetch recent press releases with the RTPR Java SDK.
 */
public class QuickStart {
    public static void main(String[] args) throws Exception {
        RtprClient client = new RtprClient.Builder()
                .apiKey("your_api_key")
                .build();

        List<Article> articles = client.getArticles(10);
        for (Article article : articles) {
            System.out.printf("[%s] %s%n", article.getTicker(), article.getTitle());
            System.out.printf("  Source: %s  |  %s%n%n", article.getAuthor(), article.getCreated());
        }

        // Get articles for a specific ticker
        List<Article> aapl = client.getArticlesByTicker("AAPL");
        System.out.printf("Found %d articles for AAPL%n", aapl.size());

        client.close();
    }
}
