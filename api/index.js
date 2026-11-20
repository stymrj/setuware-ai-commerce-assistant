// Vercel serverless entry point — wraps the same handler server.js serves
// on localhost (npm start). No new behaviour: see vercel.json for routing.
// The handler is stateless across requests (tokens arrive in an HttpOnly
// cookie), so any Vercel instance can serve any request.
const { handleRequest } = require("../server");

module.exports = (req, res) => handleRequest(req, res);
