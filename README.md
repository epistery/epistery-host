# Epistery Host

The Epistery Host is intended to provide epistery agent services on behalf of one or more domains. It is
connected through a DNS CNAME, manages the domain key and provides the services of the epistery server
npm plugin along with the browser javascript

The Epistery Host implements a plugin model that launches chosen modules to add routes and wield the domain key.
These include a secrets manager, an auth manager, an advertising network, a domain credits utility. It's open. The
Epistery host code endeavors to provide a harness for these features, remaining slim itself.

## Features

### Domain Initialization

When first accessed, unclaimed domains are presented with a guided claiming process:

1. **Blockchain Selection** - Choose the network for domain operations (Polygon mainnet default)
2. **Wallet Connection** - Connect via Web3 wallet (MetaMask) or generate a browser-based wallet
3. **DNS Verification** - Prove ownership by adding a TXT record to the domain
4. **Admin Establishment** - The verified wallet address becomes the domain administrator

### Status Page

Once claimed, the domain displays a clean status interface showing:

* Domain name and configuration details
* Server wallet address
* Active modules and their public-facing content
* **Browser Wallet** button - Manage domain-specific identity and data wallet
* **Administrate** button - Visible only to the verified admin address

### Module System

The host uses `@metric-im/administrate/MultiSite` to spawn and manage service modules:

* Secrets Manager - Secure credential storage
* Auth Manager - Identity and access control
* Advertising Network - Ad contract management (Geistm Adnet)
* Domain Credits - Usage tracking and billing

Modules add routes, wield the domain key, and provide optional public-facing UI blocks on the status page.

### Technical Architecture

* Runs on ports 4080 (HTTP) and 4443 (HTTPS)
* Uses `@metric-im/administrate/Certify` for SSL certificate management
* Domain configuration via epistery `Config` module
* Clean, framework-free frontend (no React/Vue)

## Future Todo Notes

Config stores domain private keys in the home folder. We will soon want a verion of the config module that uses
HSM features available through OCI to properly secure these keys in hardware.

I have not yet thought through how to, or if to, bind browser keys (currently called rivets) lax. localStorage
is strict, so epistery.publisherdomain.com is a different key from publisherdomain.com.

Graphs and charts are fun. The epistery host status page should show innocuous data about the page traffic.
A white-washed glimpse at google analytics for the domain. The user should be given buttons to see their
address data on third party sites. It's important to reinforce that the user information is theirs and theirs
alone to share.
