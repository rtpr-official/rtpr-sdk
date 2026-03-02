#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace rtpr {

struct Article {
    std::string ticker;
    std::string title;
    std::string author;
    std::string created;
    std::string article_body;
    std::string exchange;
    std::string article_body_html;
    std::string id;
    std::vector<std::string> tickers;

    static Article from_json(const nlohmann::json& j) {
        Article a;
        a.ticker = j.value("ticker", "");
        a.title = j.value("title", "");
        a.author = j.value("author", "");
        a.created = j.value("created", "");
        a.article_body = j.value("article_body", "");
        a.exchange = j.value("exchange", "");
        a.article_body_html = j.value("article_body_html", "");
        a.id = j.value("id", "");
        if (j.contains("tickers") && j["tickers"].is_array()) {
            a.tickers = j["tickers"].get<std::vector<std::string>>();
        }
        return a;
    }
};

struct ArticlesResponse {
    int count;
    std::vector<Article> articles;

    static ArticlesResponse from_json(const nlohmann::json& j) {
        ArticlesResponse r;
        r.count = j.value("count", 0);
        if (j.contains("articles") && j["articles"].is_array()) {
            for (const auto& item : j["articles"]) {
                r.articles.push_back(Article::from_json(item));
            }
        }
        return r;
    }
};

}  // namespace rtpr
