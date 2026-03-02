#include <iostream>
#include <string>
#include <algorithm>
#include "rtpr/websocket.hpp"

int main() {
    rtpr::WebSocketClient ws("your_api_key");

    ws.on_connect([]() {
        std::cout << "Connected to RTPR real-time feed\n";
    });

    ws.on_article([](const rtpr::Article& article) {
        std::cout << "[" << article.ticker << "] " << article.title << "\n";
        std::cout << "  Source: " << article.author << "\n";
        auto body_preview = article.article_body.substr(
            0, std::min<size_t>(120, article.article_body.size()));
        std::cout << "  Body:   " << body_preview << "...\n\n";
    });

    ws.on_error([](const std::string& error) {
        std::cerr << "Error: " << error << "\n";
    });

    ws.on_disconnect([](int code, const std::string& reason) {
        std::cout << "Disconnected (code=" << code << "): " << reason << "\n";
    });

    // Subscribe to specific tickers, or {"*"} for firehose
    ws.connect({"AAPL", "TSLA", "NVDA", "MSFT"});

    return 0;
}
