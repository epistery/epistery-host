# Code Restructuring

The many code iterations of epistery-host, and its role in epistery ecosystem, has introduced sludge which
is confusing the otherwise clear purpose of the module.

This project is not to invent anything new but to adjust the code that serves client pages and widgets.

## Move pages/widgets.mjs into public/scripts/

Widgets.mjs should be served as we serve common.mjs

## Merge ./pages/ ./public/

* pages/acl.html -> public/acl.html
* pages/widgets/requestAccess.html -> public/widgets/requestAccess.html
* pages/requestAccess.html -> Replaced by the above of the same name? If true we drop it

## Consolidate the management of /public assets and /pages and widgets

in index.mjs, line 42, /pages/widgets/:widget.html duplicates the code that
serves all static files to the client. 

## Search and cleanup duplicated or abandoned code

Consider in particular these files

* pages/index.mjs
* acl.mjs
* index.mjs (of course)
* pages/widgets/requestAccess.html
* pages/requestAccess.html
* public/service-worker.js 

## Update EpisteryArchitecture

At http://localhost:4080/agent/epistery/wiki/EpisteryArchitecture. Please be sure to review as a guide for the
code suggestions above.
