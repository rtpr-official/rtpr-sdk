package io.rtpr.sdk;

import com.google.gson.Gson;
import io.rtpr.sdk.exception.AuthenticationException;
import io.rtpr.sdk.exception.RateLimitException;
import io.rtpr.sdk.exception.RtprException;
import io.rtpr.sdk.model.Article;
import io.rtpr.sdk.model.ArticlesResponse;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Synchronous client for the RTPR REST API.
 *
 * <pre>{@code
 * RtprClient client = new RtprClient.Builder()
 *     .apiKey("your_api_key")
 *     .build();
 *
 * List<Article> articles = client.getArticles(10);
 * for (Article a : articles) {
 *     System.out.println(a.getTicker() + ": " + a.getTitle());
 * }
 * }</pre>
 */
public class RtprClient {
    private static final String DEFAULT_BASE_URL = "https://api.rtpr.io";

    private final String apiKey;
    private final String baseUrl;
    private final OkHttpClient httpClient;
    private final Gson gson;

    private RtprClient(Builder builder) {
        this.apiKey = builder.apiKey;
        this.baseUrl = builder.baseUrl;
        this.gson = new Gson();
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(builder.timeoutSeconds, TimeUnit.SECONDS)
                .readTimeout(builder.timeoutSeconds, TimeUnit.SECONDS)
                .build();
    }

    /**
     * Get recent press releases across all tickers.
     *
     * @param limit Number of articles to return (default: 20, max: 100)
     * @return List of articles
     */
    public List<Article> getArticles(int limit) throws RtprException {
        HttpUrl url = HttpUrl.parse(baseUrl + "/articles").newBuilder()
                .addQueryParameter("limit", String.valueOf(limit))
                .build();
        String json = executeRequest(url);
        ArticlesResponse response = gson.fromJson(json, ArticlesResponse.class);
        return response.getArticles();
    }

    /**
     * Get recent press releases across all tickers with default limit (20).
     */
    public List<Article> getArticles() throws RtprException {
        return getArticles(20);
    }

    /**
     * Get press releases for a specific ticker.
     *
     * @param ticker Stock ticker symbol (e.g., "AAPL", "TSLA")
     * @param limit  Number of articles to return (default: 50, max: 100)
     * @return List of articles
     */
    public List<Article> getArticlesByTicker(String ticker, int limit) throws RtprException {
        HttpUrl url = HttpUrl.parse(baseUrl + "/articles/" + ticker).newBuilder()
                .addQueryParameter("limit", String.valueOf(limit))
                .build();
        String json = executeRequest(url);
        ArticlesResponse response = gson.fromJson(json, ArticlesResponse.class);
        return response.getArticles();
    }

    /**
     * Get press releases for a specific ticker with default limit (50).
     */
    public List<Article> getArticlesByTicker(String ticker) throws RtprException {
        return getArticlesByTicker(ticker, 50);
    }

    private String executeRequest(HttpUrl url) throws RtprException {
        Request request = new Request.Builder()
                .url(url)
                .header("Authorization", "Bearer " + apiKey)
                .get()
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            String body = response.body() != null ? response.body().string() : "";

            if (response.code() == 401) {
                throw new AuthenticationException();
            }
            if (response.code() == 429) {
                throw new RateLimitException();
            }
            if (!response.isSuccessful()) {
                throw new RtprException("API error: " + body, response.code());
            }
            return body;
        } catch (IOException e) {
            throw new RtprException("Network error: " + e.getMessage(), e);
        }
    }

    /**
     * Shuts down the HTTP client connection pool.
     */
    public void close() {
        httpClient.dispatcher().executorService().shutdown();
        httpClient.connectionPool().evictAll();
    }

    /**
     * Builder for constructing an RtprClient.
     */
    public static class Builder {
        private String apiKey;
        private String baseUrl = DEFAULT_BASE_URL;
        private long timeoutSeconds = 30;

        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        public Builder timeout(long seconds) {
            this.timeoutSeconds = seconds;
            return this;
        }

        public RtprClient build() {
            if (apiKey == null || apiKey.isEmpty()) {
                throw new IllegalArgumentException("API key is required");
            }
            return new RtprClient(this);
        }
    }
}
