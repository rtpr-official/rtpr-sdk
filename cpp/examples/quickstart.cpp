#include <iostream>
#include "rtpr/client.hpp"

int main() {
    try {
        rtpr::Client client("your_api_key");

        // Get recent articles across all tickers
        auto articles = client.get_articles(10);
        std::cout << "Found " << articles.size() << " articles\n\n";

        for (const auto& a : articles) {
            std::cout << "[" << a.ticker << "] " << a.title << "\n";
            std::cout << "  Source: " << a.author << "  |  " << a.created << "\n\n";
        }

        // Get articles for a specific ticker
        auto aapl = client.get_articles_by_ticker("AAPL");
        std::cout << "Found " << aapl.size() << " articles for AAPL\n";

    } catch (const rtpr::AuthenticationError& e) {
        std::cerr << "Auth error: " << e.what() << "\n";
    } catch (const rtpr::RateLimitError& e) {
        std::cerr << "Rate limit: " << e.what() << "\n";
    } catch (const rtpr::RtprError& e) {
        std::cerr << "RTPR error: " << e.what() << "\n";
    }

    return 0;
}
