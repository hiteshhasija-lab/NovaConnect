// Only real application pages can become a post-login destination.
function loginDestination(value) {
  if (typeof value !== 'string' || /[\\\r\n]/.test(value)) return null;
  if (!/^\/(?:app(?:\/(?:channel\/[^/?#]+|dm\/[^/?#]+|meet\/[^/?#]+))?|profile|admin\/(?:users|reports))\/?(?:[?#].*)?$/.test(value)) return null;
  return value;
}
module.exports = { loginDestination };
