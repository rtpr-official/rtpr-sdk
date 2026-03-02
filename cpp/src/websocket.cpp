#include "rtpr/websocket.hpp"
#include "rtpr/exceptions.hpp"

#include <boost/asio.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/beast.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/beast/websocket/ssl.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <thread>

namespace beast = boost::beast;
namespace websocket = beast::websocket;
namespace net = boost::asio;
namespace ssl = net::ssl;
using tcp = net::ip::tcp;

namespace rtpr {

struct WebSocketClient::Impl {
    net::io_context ioc;
    ssl::context ctx{ssl::context::tlsv12_client};
    std::unique_ptr<websocket::stream<beast::ssl_stream<tcp::socket>>> ws;
};

WebSocketClient::WebSocketClient(const std::string& api_key,
                                 const std::string& ws_url,
                                 bool auto_reconnect)
    : api_key_(api_key),
      ws_url_(ws_url),
      auto_reconnect_(auto_reconnect),
      running_(false),
      impl_(std::make_unique<Impl>()) {}

WebSocketClient::~WebSocketClient() {
    stop();
}

void WebSocketClient::on_article(ArticleCallback callback) {
    article_cb_ = std::move(callback);
}

void WebSocketClient::on_connect(ConnectCallback callback) {
    connect_cb_ = std::move(callback);
}

void WebSocketClient::on_error(ErrorCallback callback) {
    error_cb_ = std::move(callback);
}

void WebSocketClient::on_disconnect(DisconnectCallback callback) {
    disconnect_cb_ = std::move(callback);
}

void WebSocketClient::connect(const std::vector<std::string>& tickers) {
    tickers_ = tickers;
    running_ = true;

    double delay = 1.0;
    const double max_delay = 60.0;

    while (running_) {
        try {
            run_connection();
            delay = 1.0;
        } catch (const std::exception& e) {
            if (error_cb_) {
                error_cb_(e.what());
            }
        }

        if (!running_ || !auto_reconnect_) {
            break;
        }

        auto ms = static_cast<int>(delay * 1000);
        std::this_thread::sleep_for(std::chrono::milliseconds(ms));
        delay = std::min(delay * 2.0, max_delay);
    }
}

void WebSocketClient::run_connection() {
    net::io_context ioc;
    ssl::context ctx{ssl::context::tlsv12_client};
    ctx.set_default_verify_paths();

    tcp::resolver resolver{ioc};
    auto ws = std::make_unique<websocket::stream<beast::ssl_stream<tcp::socket>>>(ioc, ctx);

    // Parse host from ws_url_ (strip wss://)
    std::string host = "ws.rtpr.io";
    std::string port = "443";
    std::string target = "/?apiKey=" + api_key_;

    auto const results = resolver.resolve(host, port);
    auto ep = net::connect(beast::get_lowest_layer(*ws), results);

    if (!SSL_set_tlsext_host_name(ws->next_layer().native_handle(), host.c_str())) {
        throw ConnectionError("Failed to set SNI hostname");
    }

    ws->next_layer().handshake(ssl::stream_base::client);

    std::string ws_host = host + ":" + std::to_string(ep.port());
    ws->handshake(ws_host, target);

    impl_->ws = std::move(ws);

    beast::flat_buffer buffer;
    while (running_) {
        buffer.clear();
        impl_->ws->read(buffer);
        std::string msg = beast::buffers_to_string(buffer.data());
        dispatch_message(msg);
    }

    if (impl_->ws && impl_->ws->is_open()) {
        impl_->ws->close(websocket::close_code::normal);
    }
}

void WebSocketClient::dispatch_message(const std::string& raw) {
    auto j = nlohmann::json::parse(raw, nullptr, false);
    if (j.is_discarded()) return;

    std::string type = j.value("type", "");

    if (type == "connected") {
        if (connect_cb_) connect_cb_();
        if (!tickers_.empty() && impl_->ws && impl_->ws->is_open()) {
            nlohmann::json sub;
            sub["action"] = "subscribe";
            sub["tickers"] = tickers_;
            impl_->ws->write(net::buffer(sub.dump()));
        }
    } else if (type == "article") {
        if (article_cb_ && j.contains("data")) {
            Article article = Article::from_json(j["data"]);
            article_cb_(article);
        }
    } else if (type == "ping") {
        if (impl_->ws && impl_->ws->is_open()) {
            nlohmann::json pong;
            pong["type"] = "pong";
            impl_->ws->write(net::buffer(pong.dump()));
        }
    } else if (type == "error") {
        if (error_cb_) {
            error_cb_(j.value("message", "Unknown error"));
        }
    }
}

void WebSocketClient::subscribe(const std::vector<std::string>& tickers) {
    if (impl_->ws && impl_->ws->is_open()) {
        nlohmann::json msg;
        msg["action"] = "subscribe";
        msg["tickers"] = tickers;
        impl_->ws->write(net::buffer(msg.dump()));
        for (const auto& t : tickers) {
            tickers_.push_back(t);
        }
    }
}

void WebSocketClient::unsubscribe(const std::vector<std::string>& tickers) {
    if (impl_->ws && impl_->ws->is_open()) {
        nlohmann::json msg;
        msg["action"] = "unsubscribe";
        msg["tickers"] = tickers;
        impl_->ws->write(net::buffer(msg.dump()));
    }
}

void WebSocketClient::stop() {
    running_ = false;
    if (impl_->ws && impl_->ws->is_open()) {
        beast::error_code ec;
        impl_->ws->close(websocket::close_code::normal, ec);
    }
}

bool WebSocketClient::is_connected() const {
    return impl_->ws && impl_->ws->is_open();
}

}  // namespace rtpr
