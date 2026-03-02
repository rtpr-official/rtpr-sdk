cmake_minimum_required(VERSION 3.14)
project(rtpr-sdk VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Dependencies
find_package(CURL REQUIRED)
find_package(Boost REQUIRED COMPONENTS system)
find_package(nlohmann_json 3.11 QUIET)
find_package(OpenSSL REQUIRED)

# If nlohmann_json not found via find_package, fetch it
if(NOT nlohmann_json_FOUND)
    include(FetchContent)
    FetchContent_Declare(
        json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG v3.11.3
    )
    FetchContent_MakeAvailable(json)
endif()

# Library
add_library(rtpr
    src/client.cpp
    src/websocket.cpp
)

target_include_directories(rtpr PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)

target_link_libraries(rtpr PUBLIC
    CURL::libcurl
    Boost::system
    OpenSSL::SSL
    OpenSSL::Crypto
    nlohmann_json::nlohmann_json
)

# Examples
option(RTPR_BUILD_EXAMPLES "Build example programs" ON)
if(RTPR_BUILD_EXAMPLES)
    add_executable(rtpr_quickstart examples/quickstart.cpp)
    target_link_libraries(rtpr_quickstart PRIVATE rtpr)

    add_executable(rtpr_stream examples/stream_articles.cpp)
    target_link_libraries(rtpr_stream PRIVATE rtpr)
endif()

# Install
install(TARGETS rtpr EXPORT rtpr-targets
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
    INCLUDES DESTINATION include
)
install(DIRECTORY include/rtpr DESTINATION include)
