#import <Foundation/Foundation.h>
#import <CFNetwork/CFNetwork.h>
#import <objc/runtime.h>
#include <arpa/inet.h>
#include <errno.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

// This library changes only the game process that explicitly loads it.
static BOOL direct_enabled = NO;
static unsigned int direct_interface = 0;
static atomic_uint connection_count = 0;
static NSDictionary *disabled_proxies;
static IMP original_default_configuration;
static IMP original_ephemeral_configuration;
static IMP original_session_configuration;
static IMP original_session_delegate;
extern CFDictionaryRef SCDynamicStoreCopyProxies(CFTypeRef store);

static id configure_proxy_dictionary(id configuration) {
    [configuration setConnectionProxyDictionary:disabled_proxies];
    static atomic_uint configurations = 0;
    if (atomic_fetch_add(&configurations, 1) < 4)
        fprintf(stderr, "[PlayCoverDirect] NSURLSession proxy configuration disabled\n");
    return configuration;
}

static id direct_default_configuration(id object, SEL selector) {
    return configure_proxy_dictionary(((id (*)(id, SEL))original_default_configuration)(object, selector));
}

static id direct_ephemeral_configuration(id object, SEL selector) {
    return configure_proxy_dictionary(((id (*)(id, SEL))original_ephemeral_configuration)(object, selector));
}

static id direct_session_configuration(id object, SEL selector, id configuration) {
    return ((id (*)(id, SEL, id))original_session_configuration)(object, selector, configure_proxy_dictionary(configuration));
}

static id direct_session_delegate(id object, SEL selector, id configuration, id delegate, id queue) {
    return ((id (*)(id, SEL, id, id, id))original_session_delegate)(object, selector, configure_proxy_dictionary(configuration), delegate, queue);
}

static id direct_shared_session(id object, SEL selector) {
    static NSURLSession *session;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration defaultSessionConfiguration]];
    });
    return session;
}

static IMP replace_class_method(Class cls, SEL selector, IMP replacement) {
    Method method = class_getClassMethod(cls, selector);
    return method ? method_setImplementation(method, replacement) : NULL;
}

static int bind_destination(int fd, const struct sockaddr *address) {
    if (!direct_enabled || !address) return 0;
    int level, option;
    char ip[INET6_ADDRSTRLEN] = {0};
    unsigned int port;
    if (address->sa_family == AF_INET) {
        const struct sockaddr_in *v4 = (const struct sockaddr_in *)address;
        uint32_t host = ntohl(v4->sin_addr.s_addr);
        if ((host >> 24) == 127 || host == 0) return 0;
        level = IPPROTO_IP;
        option = IP_BOUND_IF;
        port = ntohs(v4->sin_port);
        inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof(ip));
    } else if (address->sa_family == AF_INET6) {
        const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)address;
        if (IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr) || IN6_IS_ADDR_UNSPECIFIED(&v6->sin6_addr)) return 0;
        level = IPPROTO_IPV6;
        option = IPV6_BOUND_IF;
        port = ntohs(v6->sin6_port);
        inet_ntop(AF_INET6, &v6->sin6_addr, ip, sizeof(ip));
    } else {
        return 0;
    }
    if (!direct_interface) {
        errno = ENETDOWN;
        return -1;
    }
    if (setsockopt(fd, level, option, &direct_interface, sizeof(direct_interface)) != 0) {
        fprintf(stderr, "[PlayCoverDirect] Interface binding failed: errno=%d\n", errno);
        return -1;
    }
    if (atomic_fetch_add(&connection_count, 1) < 24)
        fprintf(stderr, "[PlayCoverDirect] Wi-Fi connection to %s:%u\n", ip, port);
    return 0;
}

static int direct_connect(int fd, const struct sockaddr *address, socklen_t length) {
    if (bind_destination(fd, address) != 0) return -1;
    return connect(fd, address, length);
}

static int direct_connectx(int fd, const sa_endpoints_t *endpoints, sae_associd_t association,
                           unsigned int flags, const struct iovec *iov, unsigned int count,
                           size_t *length, sae_connid_t *connection) {
    if (endpoints && bind_destination(fd, endpoints->sae_dstaddr) != 0) return -1;
    return connectx(fd, endpoints, association, flags, iov, count, length, connection);
}

static ssize_t direct_sendto(int fd, const void *data, size_t length, int flags,
                             const struct sockaddr *address, socklen_t address_length) {
    if (bind_destination(fd, address) != 0) return -1;
    return sendto(fd, data, length, flags, address, address_length);
}

static ssize_t direct_sendmsg(int fd, const struct msghdr *message, int flags) {
    if (message && bind_destination(fd, message->msg_name) != 0) return -1;
    return sendmsg(fd, message, flags);
}

static CFDictionaryRef direct_proxy_settings(void) {
    if (!direct_enabled) return CFNetworkCopySystemProxySettings();
    return CFDictionaryCreate(kCFAllocatorDefault, NULL, NULL, 0,
                              &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

static CFDictionaryRef direct_dynamic_proxies(CFTypeRef store) {
    if (!direct_enabled) return SCDynamicStoreCopyProxies(store);
    return CFDictionaryCreate(kCFAllocatorDefault, NULL, NULL, 0,
                              &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

static CFArrayRef direct_proxies(CFURLRef url, CFDictionaryRef settings) {
    if (!direct_enabled) return CFNetworkCopyProxiesForURL(url, settings);
    const void *key = kCFProxyTypeKey;
    const void *value = kCFProxyTypeNone;
    CFDictionaryRef none = CFDictionaryCreate(kCFAllocatorDefault, &key, &value, 1,
                                               &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    const void *entry = none;
    CFArrayRef result = CFArrayCreate(kCFAllocatorDefault, &entry, 1, &kCFTypeArrayCallBacks);
    CFRelease(none);
    return result;
}

#define DIRECT_INTERPOSE(replacement, original) \
    static const struct { const void *replace; const void *original; } interpose_##original \
    __attribute__((used, section("__DATA,__interpose"))) = { (const void *)&replacement, (const void *)&original }

DIRECT_INTERPOSE(direct_connect, connect);
DIRECT_INTERPOSE(direct_connectx, connectx);
DIRECT_INTERPOSE(direct_sendto, sendto);
DIRECT_INTERPOSE(direct_sendmsg, sendmsg);
DIRECT_INTERPOSE(direct_proxy_settings, CFNetworkCopySystemProxySettings);
DIRECT_INTERPOSE(direct_proxies, CFNetworkCopyProxiesForURL);
DIRECT_INTERPOSE(direct_dynamic_proxies, SCDynamicStoreCopyProxies);

static id direct_proxy_dictionary(id object, SEL selector) {
    return disabled_proxies;
}

__attribute__((constructor))
static void configure_game_direct(void) {
    @autoreleasepool {
        NSString *bundle = [[NSBundle mainBundle] bundleIdentifier];
        if (![bundle isEqualToString:@"com.tencent.jkchess"]) return;
        direct_interface = if_nametoindex("en0");
        disabled_proxies = @{@"HTTPEnable": @NO, @"HTTPSEnable": @NO, @"SOCKSEnable": @NO,
                             @"ProxyAutoConfigEnable": @NO, @"ProxyAutoDiscoveryEnable": @NO};
        for (const char **name = (const char *[]){"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                                                 "http_proxy", "https_proxy", "all_proxy", NULL}; *name; name++)
            unsetenv(*name);
        setenv("NO_PROXY", "*", 1);
        setenv("no_proxy", "*", 1);
        Method getter = class_getInstanceMethod([NSURLSessionConfiguration class], @selector(connectionProxyDictionary));
        if (getter) method_setImplementation(getter, (IMP)direct_proxy_dictionary);
        original_default_configuration = replace_class_method([NSURLSessionConfiguration class],
            @selector(defaultSessionConfiguration), (IMP)direct_default_configuration);
        original_ephemeral_configuration = replace_class_method([NSURLSessionConfiguration class],
            @selector(ephemeralSessionConfiguration), (IMP)direct_ephemeral_configuration);
        original_session_configuration = replace_class_method([NSURLSession class],
            @selector(sessionWithConfiguration:), (IMP)direct_session_configuration);
        original_session_delegate = replace_class_method([NSURLSession class],
            @selector(sessionWithConfiguration:delegate:delegateQueue:), (IMP)direct_session_delegate);
        replace_class_method([NSURLSession class], @selector(sharedSession), (IMP)direct_shared_session);
        direct_enabled = YES;
        fprintf(stderr, "[PlayCoverDirect] Enabled for com.tencent.jkchess; en0 interface=%u; system configuration unchanged\n", direct_interface);
    }
}
