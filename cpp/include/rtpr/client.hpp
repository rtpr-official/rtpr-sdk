#pragma once

#include <functional>
#include <string>
#include <vector>

#include "rtpr/models.hpp"

namespace rtpr {

/**
 * Synchronous REST client for the RTPR API.
 *
 * Usage:
 *   rtpr::Client client("your_api_key");
 *   auto articles = client.get_articles(10);
 *   for (const auto& a : articles) {
 *       std::cout << a.ticker << ": " << a.title << std::endl;
 *   }
 */
class Client {
public:
    explicit Client(const std::string& api_key,
                    const std::string& base_url = "https://api.rtpr.io",
                    long timeout_seconds = 30);

    ~Client();

    Client(const Client&) = delete;
    Client& operator=(const Client&) = delete;
    Client(Client&&) noexcept;
    Client& operator=(Client&&) noexcept;

    /**
     * Get recent press releases across all tickers.
     * @param limit Number of articles (default: 20, max: 100)
     */
    std::vector<Article> get_articles(int limit = 20);

    /**
     * Get press releases for a specific ticker.
     * @param ticker Stock ticker symbol (e.g., "AAPL")
     * @param limit Number of articles (default: 50, max: 100)
     */
    std::vector<Article> get_articles_by_ticker(const std::string& ticker, int limit = 50);

private:
    std::string perform_request(const std::string& path);

    std::string api_key_;
    std::string base_url_;
    long timeout_seconds_;
};

}  // namespace rtpr
