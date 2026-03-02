#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "rtpr/models.hpp"

namespace rtpr {

/**
 * WebSocket client for real-time RTPR press release streaming.
 *
 * Usage:
 *   rtpr::WebSocketClient ws("your_api_key");
 *   ws.on_article([](const rtpr::Article& a) {
 *       std::cout << a.ticker << ": " << a.title << std::endl;
 *   });
 *   ws.connect({"AAPL", "TSLA"});  // blocks until disconnect
 */
class WebSocketClient {
public:
    using ArticleCallback = std::function<void(const Article&)>;
    using ConnectCallback = std::function<void()>;
    using ErrorCallback = std::function<void(const std::string&)>;
    using DisconnectCallback = std::function<void(int code, const std::string& reason)>;

    explicit WebSocketClient(const std::string& api_key,
                             const std::string& ws_url = "wss://ws.rtpr.io",
                             bool auto_reconnect = true);

    ~WebSocketClient();

    WebSocketClient(const WebSocketClient&) = delete;
    WebSocketClient& operator=(const WebSocketClient&) = delete;

    void on_article(ArticleCallback callback);
    void on_connect(ConnectCallback callback);
    void on_error(ErrorCallback callback);
    void on_disconnect(DisconnectCallback callback);

    /**
     * Connect and start streaming. Blocks until stop() is called.
     * @param tickers Ticker symbols to subscribe to, or {"*"} for firehose
     */
    void connect(const std::vector<std::string>& tickers);

    /** Subscribe to additional tickers on an active connection. */
    void subscribe(const std::vector<std::string>& tickers);

    /** Unsubscribe from tickers. */
    void unsubscribe(const std::vector<std::string>& tickers);

    /** Stop the connection and prevent reconnection. */
    void stop();

    bool is_connected() const;

private:
    void run_connection();
    void dispatch_message(const std::string& raw);

    std::string api_key_;
    std::string ws_url_;
    bool auto_reconnect_;
    std::atomic<bool> running_;
    std::vector<std::string> tickers_;

    ArticleCallback article_cb_;
    ConnectCallback connect_cb_;
    ErrorCallback error_cb_;
    DisconnectCallback disconnect_cb_;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace rtpr
