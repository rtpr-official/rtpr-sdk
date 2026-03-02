#include "rtpr/client.hpp"
#include "rtpr/exceptions.hpp"

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <sstream>

namespace rtpr {

namespace {

size_t write_callback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* response = static_cast<std::string*>(userdata);
    response->append(ptr, size * nmemb);
    return size * nmemb;
}

}  // namespace

Client::Client(const std::string& api_key, const std::string& base_url, long timeout_seconds)
    : api_key_(api_key), base_url_(base_url), timeout_seconds_(timeout_seconds) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

Client::~Client() {
    curl_global_cleanup();
}

Client::Client(Client&& other) noexcept
    : api_key_(std::move(other.api_key_)),
      base_url_(std::move(other.base_url_)),
      timeout_seconds_(other.timeout_seconds_) {}

Client& Client::operator=(Client&& other) noexcept {
    if (this != &other) {
        api_key_ = std::move(other.api_key_);
        base_url_ = std::move(other.base_url_);
        timeout_seconds_ = other.timeout_seconds_;
    }
    return *this;
}

std::vector<Article> Client::get_articles(int limit) {
    std::string path = "/articles?limit=" + std::to_string(limit);
    std::string body = perform_request(path);
    auto j = nlohmann::json::parse(body);
    auto response = ArticlesResponse::from_json(j);
    return response.articles;
}

std::vector<Article> Client::get_articles_by_ticker(const std::string& ticker, int limit) {
    std::string path = "/articles/" + ticker + "?limit=" + std::to_string(limit);
    std::string body = perform_request(path);
    auto j = nlohmann::json::parse(body);
    auto response = ArticlesResponse::from_json(j);
    return response.articles;
}

std::string Client::perform_request(const std::string& path) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw RtprError("Failed to initialize CURL");
    }

    std::string url = base_url_ + path;
    std::string response_body;
    std::string auth_header = "Authorization: Bearer " + api_key_;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, auth_header.c_str());

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout_seconds_);

    CURLcode res = curl_easy_perform(curl);

    if (res != CURLE_OK) {
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        throw ConnectionError(std::string("Request failed: ") + curl_easy_strerror(res));
    }

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (http_code == 401) {
        throw AuthenticationError();
    }
    if (http_code == 429) {
        throw RateLimitError();
    }
    if (http_code >= 400) {
        throw RtprError("API error: " + response_body, static_cast<int>(http_code));
    }

    return response_body;
}

}  // namespace rtpr
