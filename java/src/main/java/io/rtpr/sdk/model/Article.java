package io.rtpr.sdk.model;

import com.google.gson.annotations.SerializedName;
import java.util.Collections;
import java.util.List;

/**
 * A press release article from a PR wire service.
 */
public class Article {
    private String ticker;
    private String title;
    private String author;
    private String created;

    @SerializedName("article_body")
    private String articleBody;

    private String exchange;

    @SerializedName("article_body_html")
    private String articleBodyHtml;

    private String id;
    private List<String> tickers;

    public Article() {
        this.ticker = "";
        this.title = "";
        this.author = "";
        this.created = "";
        this.articleBody = "";
        this.exchange = "";
        this.articleBodyHtml = "";
        this.id = "";
        this.tickers = Collections.emptyList();
    }

    public String getTicker() { return ticker; }
    public String getTitle() { return title; }
    public String getAuthor() { return author; }
    public String getCreated() { return created; }
    public String getArticleBody() { return articleBody; }
    public String getExchange() { return exchange; }
    public String getArticleBodyHtml() { return articleBodyHtml; }
    public String getId() { return id; }
    public List<String> getTickers() { return tickers != null ? tickers : Collections.emptyList(); }

    @Override
    public String toString() {
        return String.format("Article{ticker='%s', title='%s', author='%s'}", ticker, title, author);
    }
}
