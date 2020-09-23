
/*
  This is JavaScript that needs to be run in both browsers and NodeJS.
*/

import * as config from './config.mjs'
import * as utils from '../utils.mjs'
import * as clientUtils from './utils.mjs'
import * as defines from './defines.mjs'
import * as fetching from './fetching.mjs'
const assert = utils.assert
const setupCheck = clientUtils.setupCheck

export var testUUIDs = {}
export var testResults = {}

export function makeCacheTest (test) {
  return new Promise((resolve, reject) => {
    var uuid = utils.token()
    testUUIDs[test.id] = uuid
    var requests = fetching.inflateRequests(test)
    var responses = []
    var fetchFunctions = []
    for (let i = 0; i < requests.length; ++i) {
      fetchFunctions.push({
        code: idx => {
          var reqConfig = requests[idx]
          var reqNum = idx + 1
          var url = clientUtils.makeTestUrl(uuid, reqConfig)
          var init = fetching.init(idx, reqConfig)
          if (test.dump === true) clientUtils.logRequest(url, init, reqNum)
          const checkResponse = makeCheckResponse(idx, reqConfig, uuid, test.dump)
          return config.fetch(url, init)
            .then(response => {
              responses.push(response)
              return checkResponse(response)
            })
        },
        pauseAfter: 'pause_after' in requests[i]
      })
    }

    var idx = 0
    function runNextStep () {
      if (fetchFunctions.length) {
        var nextFetchFunction = fetchFunctions.shift()
        if (nextFetchFunction.pauseAfter === true) {
          return nextFetchFunction.code(idx++)
            .then(clientUtils.pause)
            .then(runNextStep)
        } else {
          return nextFetchFunction.code(idx++)
            .then(runNextStep)
        }
      }
    }

    return clientUtils.putTestConfig(uuid, requests)
      .then(runNextStep)
      .then(() => {
        return clientUtils.getServerState(uuid)
      })
      .then(testState => {
        checkRequests(requests, responses, testState)
      })
      .then(() => { // pass
        if (test.id in testResults) throw new Error(`Duplicate test ${test.id}`)
        testResults[test.id] = true
        resolve()
      })
      .catch(err => { // fail
        if (test.id in testResults) throw new Error(`Duplicate test ${test.id}`)
        testResults[test.id] = [(err.name || 'unknown'), err.message]
        resolve()
      })
  })
}

function makeCheckResponse (idx, reqConfig, uuid, dump) {
  return function checkResponse (response) {
    var reqNum = idx + 1
    var resNum = parseInt(response.headers.get('Server-Request-Count'))
    if (dump === true) clientUtils.logResponse(response, reqNum)
    if ('expected_type' in reqConfig) {
      var typeSetup = setupCheck(reqConfig, 'expected_type')
      if (reqConfig.expected_type === 'cached') {
        if (response.status === 304 && isNaN(resNum)) { // some caches will not include the hdr
          // pass
        } else {
          assert(typeSetup, resNum < reqNum, `Response ${reqNum} does not come from cache`)
        }
      }
      if (reqConfig.expected_type === 'not_cached') {
        assert(typeSetup, resNum === reqNum, `Response ${reqNum} comes from cache`)
      }
    }
    //  browsers seem to squelch 304 even in no-store mode.
    //    if (!config.useBrowserCache && 'expected_type' in reqConfig && reqConfig.expected_type.endsWith('validated')) {
    //      reqConfig.expected_status = 304
    //    }
    if ('expected_status' in reqConfig) {
      assert(setupCheck(reqConfig, 'expected_status'),
        response.status === reqConfig.expected_status,
        `Response ${reqNum} status is ${response.status}, not ${reqConfig.expected_status}`)
    } else if ('response_status' in reqConfig) {
      assert(true, // response status is always setup
        response.status === reqConfig.response_status[0],
        `Response ${reqNum} status is ${response.status}, not ${reqConfig.response_status[0]}`)
    } else if (response.status === 999) {
      // special condition; the server thought it should have received a conditional request.
      assert(setupCheck(reqConfig, 'expected_type'), false,
        `Request ${reqNum} should have been conditional, but it was not.`)
    } else {
      assert(true, // default status is always setup
        response.status === 200,
        `Response ${reqNum} status is ${response.status}, not 200`)
    }
    if ('expected_response_headers' in reqConfig) {
      var respPresentSetup = setupCheck(reqConfig, 'expected_response_headers')
      reqConfig.expected_response_headers.forEach(header => {
        if (typeof header === 'string') {
          assert(respPresentSetup, response.headers.has(header),
            `Response ${reqNum} ${header} header not present.`)
        } else if (header.length > 2) {
          assert(respPresentSetup, response.headers.has(header[0]),
            `Response ${reqNum} ${header[0]} header not present.`)

          const value = response.headers.get(header[0])
          let msg, condition
          if (header[1] === '=') {
            const expected = response.headers.get(header[2])
            condition = value === expected
            msg = `match ${header[2]} (${expected})`
          } else if (header[1] === '>') {
            const expected = header[2]
            condition = parseInt(value) > expected
            msg = `be bigger than ${expected}`
          } else {
            throw new Error(`Unknown expected-header operator '${header[1]}'`)
          }

          assert(respPresentSetup, condition,
            `Response ${reqNum} header ${header[0]} is ${value}, should ${msg}`)
        } else {
          assert(respPresentSetup, response.headers.get(header[0]) === header[1],
            `Response ${reqNum} header ${header[0]} is "${response.headers.get(header[0])}", not "${header[1]}"`)
        }
      })
    }
    if ('expected_response_headers_missing' in reqConfig) {
      var respMissingSetup = setupCheck(reqConfig, 'expected_response_headers_missing')
      reqConfig.expected_response_headers_missing.forEach(header => {
        assert(respMissingSetup, !response.headers.has(header),
          `Response ${reqNum} includes unexpected header ${header}: "${response.headers.get(header)}"`)
      })
    }
    return response.text().then(makeCheckResponseBody(reqConfig, uuid, response.status))
  }
}

function makeCheckResponseBody (reqConfig, uuid, statusCode) {
  return function checkResponseBody (resBody) {
    if ('check_body' in reqConfig && reqConfig.check_body === false) {

    } else if ('expected_response_text' in reqConfig) {
      if (reqConfig.expected_response_text !== null) {
        assert(setupCheck(reqConfig, 'expected_response_text'),
          resBody === reqConfig.expected_response_text,
          `Response body is "${resBody}", not "${reqConfig.expected_response_text}"`)
      }
    } else if ('response_body' in reqConfig && reqConfig.response_body !== null) {
      assert(true, // response_body is always setup
        resBody === reqConfig.response_body,
        `Response body is "${resBody}", not "${reqConfig.response_body}"`)
    } else if (!defines.noBodyStatus.has(statusCode) && reqConfig.request_method !== 'HEAD') {
      assert(true, // no_body is always setup
        resBody === uuid,
        `Response body is "${resBody}", not "${uuid}"`)
    }
  }
}

function checkRequests (requests, responses, testState) {
  // compare a test's requests array against the server-side testState
  var testIdx = 0
  for (let i = 0; i < requests.length; ++i) {
    var expectedValidatingHeaders = []
    var reqConfig = requests[i]
    var response = responses[i]
    var serverRequest = testState[testIdx]
    var reqNum = i + 1
    if ('expected_type' in reqConfig) {
      var typeSetup = setupCheck(reqConfig, 'expected_type')
      if (reqConfig.expected_type === 'cached') continue // the server will not see the request
      if (reqConfig.expected_type === 'not_cached') {
        assert(typeSetup, serverRequest.request_num === reqNum, `Response ${reqNum} comes from cache (${serverRequest.request_num} on server)`)
      }
      if (reqConfig.expected_type === 'etag_validated') {
        expectedValidatingHeaders.push('if-none-match')
      }
      if (reqConfig.expected_type === 'lm_validated') {
        expectedValidatingHeaders.push('if-modified-since')
      }
    }
    testIdx++ // only increment for requests the server sees
    expectedValidatingHeaders.forEach(vhdr => {
      assert(typeSetup, typeof (serverRequest) !== 'undefined', `request ${reqNum} wasn't sent to server`)
      assert(typeSetup, Object.prototype.hasOwnProperty.call(serverRequest.request_headers, vhdr),
        `request ${reqNum} doesn't have ${vhdr} header`)
    })
    if ('expected_request_headers' in reqConfig) {
      var reqPresentSetup = setupCheck(reqConfig, 'expected_request_headers')
      reqConfig.expected_request_headers.forEach(header => {
        if (typeof header === 'string') {
          var headerName = header.toLowerCase()
          assert(reqPresentSetup, Object.prototype.hasOwnProperty.call(serverRequest.request_headers, headerName),
            `Request ${reqNum} ${header} header not present.`)
        } else {
          var reqValue = serverRequest.request_headers[header[0].toLowerCase()]
          assert(reqPresentSetup, reqValue === header[1],
            `Request ${reqNum} header ${header[0]} is "${reqValue}", not "${header[1]}"`)
        }
      })
    }
    if (typeof serverRequest !== 'undefined' && 'response_headers' in serverRequest) {
      serverRequest.response_headers.forEach(header => {
        if (config.useBrowserCache && defines.forbiddenResponseHeaders.has(header[0].toLowerCase())) {
          // browsers prevent reading these headers through the Fetch API so we can't verify them
          return
        }
        if (defines.skipResponseHeaders.has(header[0].toLowerCase())) {
          // these just cause spurious failures
          return
        }
        let received = response.headers.get(header[0])
        // XXX: assumes that if a proxy joins headers, it'll separate them with a comma and exactly one space
        if (Array.isArray(received)) {
          received = received.join(', ')
        }
        if (Array.isArray(header[1])) {
          header[1] = header[1].join(', ')
        }
        assert(true, // default headers is always setup
          received === header[1],
          `Response ${reqNum} header ${header[0]} is "${received}", not "${header[1]}"`)
      })
    }
  }
}
