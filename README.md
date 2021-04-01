# Requirements

- [Node.js v14 and npm v6](https://nodejs.org/en/download/) **NOTICE, if using other versions, the tool may not produce correct results**
- [nodeprof.js](https://github.com/Haiyang-Sun/nodeprof.js)

# Installation

```
npm install
npm run build
```

Set the NODE_HOME environment variable to point to the folder containing the nodeprof.js Graal node binary.

```
export NODE_HOME="node_prof_workspace/graal/sdk/latest_graalvm_home/"
```

# Running on a single client

It is possible to run the security scanner on a single client:

```
node dist/src/call-graph/index.js <client-folder>
```

# License

Copyright 2021 casa.au.dk

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
End license text.
