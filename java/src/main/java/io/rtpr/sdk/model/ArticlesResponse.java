package io.rtpr.sdk.model;

import java.util.Collections;
import java.util.List;

/**
 * Response from the /articles endpoint.
 */
public class ArticlesResponse {
    private int count;
    private List<Article> articles;

    public ArticlesResponse() {
        this.count = 0;
        this.articles = Collections.emptyList();
    }

    public int getCount() { return count; }
    public List<Article> getArticles() { return articles != null ? articles : Collections.emptyList(); }
}
