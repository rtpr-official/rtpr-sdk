#pragma once

#include <stdexcept>
#include <string>

namespace rtpr {

class RtprError : public std::runtime_error {
public:
    explicit RtprError(const std::string& message, int status_code = 0)
        : std::runtime_error(message), status_code_(status_code) {}

    int status_code() const noexcept { return status_code_; }

private:
    int status_code_;
};

class AuthenticationError : public RtprError {
public:
    explicit AuthenticationError(const std::string& message = "Invalid or missing API key")
        : RtprError(message, 401) {}
};

class RateLimitError : public RtprError {
public:
    explicit RateLimitError(const std::string& message = "Rate limit exceeded (60 requests/minute)")
        : RtprError(message, 429) {}
};

class ConnectionError : public RtprError {
public:
    explicit ConnectionError(const std::string& message = "Failed to connect to RTPR WebSocket")
        : RtprError(message) {}
};

}  // namespace rtpr
