const child = require('child_process')
const { Duplex } = require('stream')
const net = require('net')
const crypto = require('crypto')
const {
  createHash, createHmac, createSign, createCipheriv,
  createDecipheriv, publicEncrypt, randomFillSync
} = crypto

const { concat, from } = Buffer

/**
 * new Error('This socket has been ended by the other party');
 * EPIPE
 */

/**
 * content type for TLS record layer
 * @readonly
 * @enum {number}
 */
const CHANGE_CIPHER_SPEC = 20
const ALERT = 21
const HANDSHAKE = 22
const APPLICATION_DATA = 23

/**
 * handshake record type
 * @readonly
 * @enum {number} - 1 byte
 */
const HELLO_REQUEST = 0
const CLIENT_HELLO = 1
const SERVER_HELLO = 2
const CERTIFICATE = 11
const SERVER_KEY_EXCHANGE = 12
const CERTIFICATE_REQUEST = 13
const SERVER_HELLO_DONE = 14
const CERTIFICATE_VERIFY = 15
const CLIENT_KEY_EXCHANGE = 16
const FINISHED = 20

/**
 * @param {number} handshake message type
 * @returns {string} handshake message name
 */
const handshakeTypeName = type => {
  switch (type) {
    case HELLO_REQUEST:
      return 'HelloRequest'
    case CLIENT_HELLO:
      return 'ClientHello'
    case SERVER_HELLO:
      return 'ServerHello'
    case CERTIFICATE:
      return 'Certificate'
    case SERVER_KEY_EXCHANGE:
      return 'ServerKeyExchange'
    case CERTIFICATE_REQUEST:
      return 'CertificateRequest'
    case SERVER_HELLO_DONE:
      return 'ServerHelloDone'
    case CERTIFICATE_VERIFY:
      return 'CertificateVerify'
    case CLIENT_KEY_EXCHANGE:
      return 'ClientKeyExchange'
    case FINISHED:
      return 'Finished'
    default:
      throw new Error(`unknown handshake type ${type}`)
  }
}

/**
 *
 */
const WARNING = 1
const FATAL = 2

/**
 *
 */
const alertLevel = level => {
  switch (level) {
    case WARNING:
      return 'warning'
    case FATAL:
      return 'fatal'
    default:
      throw new Error(`unknown alert level ${level}`)
  }
}

/**
 * alert description (warning or error)
 * @readonly
 * @enum {number} - 1 byte
 */
const CLOSE_NOTIFY = 0
const UNEXPECTED_MESSAGE = 10
const BAD_RECORD_MAC = 20
const DECRYPTION_FAILED_RESERVED = 21
const RECORD_OVERFLOW = 22
const DECOMPRESSION_FAILURE = 30
const HANDSHAKE_FAILURE = 40
const NO_CERTIFICATE_RESERVED = 41
const BAD_CERTIFICATE = 42
const UNSUPPORTED_CERTIFICATE = 43
const CERTIFICATE_REVOKED = 44
const CERTIFICATE_EXPIRED = 45
const CERTIFICATE_UNKNOWN = 46
const ILLEGAL_PARAMETER = 47
const UNKNOWN_CA = 48
const ACCESS_DENIED = 49
const DECODE_ERROR = 50
const DECRYPT_ERROR = 51
const EXPORT_RESTRICTION_RESERVED = 60
const PROTOCOL_VERSION = 70
const INSUFFICIENT_SECURITY = 71
const INTERNAL_ERROR = 80
const USER_CANCELED = 90
const NO_RENEGOTIATION = 100
const UNSUPPORTED_EXTENSION = 110

/**
 * @returns {string} name
 */
const alertDescription = desc => {
  switch (desc) {
    case CLOSE_NOTIFY:
      return 'close_notify'
    case UNEXPECTED_MESSAGE:
      return 'unexpected_message'
    case BAD_RECORD_MAC:
      return 'bad_record_mac'
    case DECRYPTION_FAILED_RESERVED:
      return 'decryption_failed_reserved'
    case RECORD_OVERFLOW:
      return 'record_overflow'
    case DECOMPRESSION_FAILURE:
      return 'decompression_failure'
    case HANDSHAKE_FAILURE:
      return 'handshake_failure'
    case NO_CERTIFICATE_RESERVED:
      return 'no_certificate_reserved'
    case BAD_CERTIFICATE:
      return 'bad_certificate'
    case UNSUPPORTED_CERTIFICATE:
      return 'unsupported_certificate'
    case CERTIFICATE_REVOKED:
      return 'certificate_revoked'
    case CERTIFICATE_EXPIRED:
      return 'certificate_expired'
    case CERTIFICATE_UNKNOWN:
      return 'certificate_unknown'
    case ILLEGAL_PARAMETER:
      return 'illegal_parameter'
    case UNKNOWN_CA:
      return 'unknown_ca'
    case ACCESS_DENIED:
      return 'access_denied'
    case DECODE_ERROR:
      return 'decode_error'
    case DECRYPT_ERROR:
      return 'decrypt_error'
    case EXPORT_RESTRICTION_RESERVED:
      return 'export_restriction_reserved'
    case PROTOCOL_VERSION:
      return 'protocol_version'
    case INSUFFICIENT_SECURITY:
      return 'insufficient_security'
    case INTERNAL_ERROR:
      return 'internal_error'
    case USER_CANCELED:
      return 'user_cancelled'
    case NO_RENEGOTIATION:
      return 'no_renegotiation'
    case UNSUPPORTED_EXTENSION:
      return 'unsupported_extension'
    default:
      // description may be extended by other spec
      return 'unknown_alert_description'
  }
}

/**
 * TLSError is an internal class representing an
 * tls protocol error. It extends Error for preserving
 * error stack and debug printing.
 */
class TLSError extends Error {
  constructor (desc, msg) {
    if (msg instanceof Error) {
      super(msg.message)
      Object.assign(this, msg)
      this.stack = msg.stack
    } else {
      super(msg || alertDescription(desc))
    }
    this.name = this.name || this.constructor.name
    this.level = FATAL
    this.description = desc
  }
}

/**
 * TLSAlert represents a tls alert received from the other party
 */
class TLSAlert {
  constructor (desc) {
    this.description = desc
    this.level = desc === CLOSE_NOTIFY ? WARNING : FATAL
  }
}

/**
 * decipher error, this error may be thrown by
 * decipher, but should never be sent to server,
 * use bad_record_mac instead
 *
 * ```
 * RFC 4346, TLS v1.1, page 28
 * Note: Differentiating between bad_record_mac and decryption_failed
 *       alerts may permit certain attacks against CBC mode as used in
 *       TLS [CBCATT].  It is preferable to uniformly use the
 *       bad_record_mac alert to hide the specific type of the error.
 * ```
 */

/** @function */
const K = x => y => x
/** @constant {buffer} - TLS version 1.2 */
const VER12 = from([0x03, 0x03])
/** @constant {buffer} - cipher suite */
const AES_128_CBC_SHA = from([0x00, 0x2f])
/** @constant {buffer} - signature algorithm */
const RSA_PKCS1_SHA256 = from([0x04, 0x01])
/** @constant {number} - for public key encryption padding */
const RSA_PKCS1_PADDING = crypto.constants.RSA_PKCS1_PADDING

/**
 * convert a uint8 number to a 1-byte buffer
 * @function
 * @param {number} i
 * @returns {buffer}
 */
const UInt8 = i => from([i])

/**
 * convert a uint16 number to a 2-byte buffer
 * @function
 * @param {number} i
 * @returns {buffer}
 */
const UInt16 = i => from([i >> 8, i])

/**
 * converts a uint24 number to a 3-byte buffer
 * @function
 * @param {number} i
 * @returns {buffer}
 */
const UInt24 = i => from([i >> 16, i >> 8, i])

/**
 * reads a uint24 number from the first 3-byte of a buffer
 * @function
 * @param {buffer} buf
 * @returns {number}
 */
const readUInt24 = buf => buf[0] * 65536 + buf[1] * 256 + buf[2]

/**
 * prepends 1-byte length to given buffer
 * @function
 * @param {buffer} b
 * @returns {buffer}
 */
const Prepend8 = b => concat([UInt8(b.length), b])

/**
 * prepends 2-byte length to given buffer
 * @function
 * @param {buffer} b
 * @returns {buffer}
 */
const Prepend16 = b => concat([UInt16(b.length), b])

/**
 * prepends 3-byte length to given buffer
 * @function
 * @param {buffer} b
 * @returns {buffer}
 */
const Prepend24 = b => concat([UInt24(b.length), b])

/**
 * generates a buffer with given size and filled with random bytes
 * @function
 * @param {number} size
 * @returns {buffer}
 */
const randomBuffer = size => randomFillSync(Buffer.alloc(size))

/**
 * calculates sha256 digest
 * @param {buffer} data
 * @returns {buffer}
 */
const SHA256 = data => createHash('sha256').update(data).digest()

/**
 * calculates sha1 hmac
 * @param {buffer} key - mac key
 * @param {buffer} data
 * @returns {buffer}
 */
const HMAC1 = (key, data) => createHmac('sha1', key).update(data).digest()

/**
 * calculates sha256 hmac
 * @param {buffer} key - mac key
 * @param {buffer} data
 * @returns {buffer}
 */
const HMAC256 = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * pseudo random function for key generation and expansion
 * @function
 * @param {buffer} secret
 * @param {string} label text
 * @param {buffer} seed
 * @param {number} length
 * @returns {buffer} buffer of given length
 */
const PRF256 = (secret, label, seed, length) => {
  seed = concat([from(label, 'binary'), seed])
  let P_HASH = Buffer.alloc(0)
  for (let A = from(seed); P_HASH.length < length;
    A = HMAC256(secret, A),
    P_HASH = concat([P_HASH, HMAC256(secret, concat([A, seed]))]));
  return P_HASH.slice(0, length)
}

/**
 * A sequence number function returns sequence number starting from 0
 * @typedef SequenceNumberFunction
 * @type {function}
 * @return {buffer}
 */

/**
 * create a sequence number function
 * @returns {SequenceNumberFunction}
 */
const createSequenceNumber = () => {
  const buf = Buffer.alloc(8)
  return () => {
    const r = from(buf)
    buf.writeUInt32BE(buf.readUInt32BE(4) + 1, 4)
    if (buf.readUInt32BE(4) === 0) {
      buf.writeUInt32BE(buf.readUInt32BE(0) + 1, 0)

      // rfc5246, seq num should never overflow since it is a 64bit number
      // so this error is considered to be an internal error
      if (buf.readUInt32BE(0) === 0) {
        throw new Error('sequence number overflow')
      }
    }
    return r
  }
}

/**
 * A cipher function encrypts a tls record.
 * @typedef CipherFunction
 * @type {function}
 * @param { type - tls record type
 * @param {buffer} data - tls record data (payload)
 * @returns {buffer} encrypted tls record
 */

/**
 * This is a (higher-order) factory function to generate a cipher function,
 * which maintains sequence number internally.
 * @function createCipher
 * @param {buffer} key - encryption key
 * @param {buffer} macKey - hmac key
 * @param {bigint} _iv - initial iv
 * @returns {CipherFunction}
 */
const createCipher = (key, macKey, _iv) => {
  const SN = createSequenceNumber()
  return (type, data) => {
    const iv = SHA256((++_iv).toString()).slice(0, 16)
    const tbs = concat([SN(), UInt8(type), VER12, Prepend16(data)])
    const mac = HMAC1(macKey, tbs)
    const len = 16 - (data.length + mac.length) % 16
    const pad = Buffer.alloc(len, len - 1)
    const c = createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false)
    return concat([iv, c.update(concat([data, mac, pad])), c.final()])
  }
}

/**
 * A decipher function decrypts a tls record.
 * @typedef DecipherFunction
 * @type {function}
 * @param { type - tls record type
 * @param {buffer} data - encrypted tls record data
 * @returns {buffer} decrypted data (payload), mac verified and stripped
 */

/**
 * This is a higher order factory funtion to generate a decipher function,
 * which maintains sequence number internally.
 *
 * @function createDecipher
 * @param {buffer} key - decryption key
 * @param {buffer} macKey - hmac key
 * @returns {DecipherFunction}
 */
const createDecipher = (key, macKey) => {
  const SN = createSequenceNumber()
  return (type, data) => {
    const iv = data.slice(0, 16)
    const d = createDecipheriv('aes-128-cbc', key, iv).setAutoPadding(false)

    let u, f
    try {
      u = d.update(data.slice(16))
      f = d.final()
    } catch (e) {
      throw new TLSError(DECRYPTION_FAILED_RESERVED)
    }
    const dec = concat([u, f])

    const len = dec[dec.length - 1] + 1
    if (dec.length < len) {
      throw new TLSError(DECRYPTION_FAILED_RESERVED, 'bad padding')
    }
    const pad = dec.slice(dec.length - len)
    if (!pad.equals(Buffer.alloc(len, len - 1))) {
      throw new TLSError(DECRYPTION_FAILED_RESERVED, 'bad padding')
    }
    data = dec.slice(0, dec.length - len - 20)
    const smac = dec.slice(dec.length - len - 20, dec.length - len)
    const tbs = concat([SN(), UInt8(type), VER12, Prepend16(data)])
    const cmac = HMAC1(macKey, tbs)

    if (!smac.equals(cmac)) {
      throw new TLSError(BAD_RECORD_MAC)
    }
    return data
  }
}

/**
 * convert a der certificate to pem format
 * @param {Buffer} der - certificate in DER format
 * @returns {string} certificate in PEM format
 */
const derToPem = der =>
`-----BEGIN CERTIFICATE-----
${der.toString('base64')}
-----END CERTIFICATE-----`

/**
 * execute a command using bash shell with given input
 * @param {string} cmd - command line
 * @param {string} input - data written to stdin
 * @param {function} callback - `(err, stdout, stderr) => {}`
 */
const bash = (cmd, input, callback) => {
  const c = child.exec(cmd, { shell: '/bin/bash' }, callback)
  c.stdin.write(input)
  c.stdin.end()
}

/**
 * verifies certificate chain using openssl
 * @param {string} cert - certificate to be verified
 * @param {string[]} intermediates - intermediate certificates
 * @param {string} ca - root ca certificates
 * @param {function} callback - `err => {}`
 */
const verifyCertificateChain = (cert, intermediates, ca, callback) => {
  const cmd = [
    `openssl verify -CAfile <(echo -e "${ca}")`,
    ...intermediates.map(i => `-untrusted <(echo -e "${i}")`)
  ].join(' ')

  bash(cmd, cert, (err, stdout, stderr) => {
    if (err) {
      callback(err)
    } else {
      if (stdout.toString().trim() === 'stdin: OK') {
        callback(null, true)
      } else {
        callback(null, false)
      }
    }
  })
}

/**
 * extracts public key from the certificate
 * @param {string} cert - certificate in PEM format
 * @param {function} callback - `(err, key) => {}`, key is a string.
 */
const extractPublicKey = (cert, callback) =>
  bash('openssl x509 -noout -pubkey', cert, callback)

/**
 * @typedef {object} Fragment
 * @property {number} type - content type
 * @property {Buffer} data - fragment data
 */

/**
 * @typedef {object} Message
 * @property {number} type - content type
 * @property {Buffer} data - message data (no fragment)
 */

/**
 * HandshakeContext stores data and states for handshake stage,
 * including:
 * - all sent and received messages (except HELLO_REQUEST)
 * - client and server random
 * - pre-master secret and master secret
 * - encryption key and mac key for both client and server
 */
class HandshakeContext {
  /** constructs handshake context */
  constructor () {
    /** cache all handshake messages except HELLO_REQUEST */
    this.buffer = []
    /** session id */
    this.sessionId = 0
    /** client random */
    this.clientRandom = randomBuffer(32)
    /** server random */
    this.serverRandom = undefined
    /** pre-master secret */
    this.preMasterSecret = concat([VER12, randomBuffer(46)])
    /** master secret */
    this.masterSecret = undefined
    /** client write mac key */
    this.clientWriteMacKey = undefined
    /** server write mac key */
    this.serverWriteMacKey = undefined
    /** client key */
    this.clientWriteKey = undefined
    /** server key */
    this.serverWriteKey = undefined
  }

  /** push a handshake message into buffer */
  push (msg) {
    this.buffer.push(msg)
  }

  /** returns to-be-signed data */
  tbs () {
    return concat(this.buffer)
  }

  /** returns SHA256 digest for to-be-signed data */
  digest () {
    return SHA256(this.tbs())
  }

  /** type of the last message */
  lastType () {
    if (this.buffer.length) {
      return this.buffer[this.buffer.length - 1][0]
    } else {
      return 255
    }
  }

  /** derive keys from pre-master secret, client and server random */
  deriveKeys () {
    this.masterSecret = PRF256(this.preMasterSecret, 'master secret',
      concat([this.clientRandom, this.serverRandom]), 48)

    const keys = PRF256(this.masterSecret, 'key expansion',
      concat([this.serverRandom, this.clientRandom]), 2 * (20 + 16) + 16)

    this.clientWriteMacKey = keys.slice(0, 20)
    this.serverWriteMacKey = keys.slice(20, 40)
    this.clientWriteKey = keys.slice(40, 56)
    this.serverWriteKey = keys.slice(56, 72)
    this.iv = Array.from(keys.slice(72))
      .reduce((sum, c, i) =>
        (sum + BigInt(c) << (BigInt(8) * BigInt(i))), BigInt(0))
  }

  /** generates client verify data (used in client Finished message) */
  clientVerifyData () {
    return PRF256(this.masterSecret, 'client finished', this.digest(), 12)
  }

  /**
   * generates server verify data
   * (used in verifying server Finsihed message)
   */
  serverVerifyData () {
    return PRF256(this.masterSecret, 'server finished', this.digest(), 12)
  }
}

/**
 * telsa state, connecting
 * @constant
 * @type {string}
 */
const CONNECTING = 'Connecting'

/**
 * telsa state, handshaking
 * @constant
 * @type {string}
 */
const HANDSHAKING = 'Handshaking'

/**
 * telsa state, established
 * @constant
 * @type {string}
 */
const ESTABLISHED = 'Established'

/**
 * telsa state, disconnected
 * @constant
 * @type {string}
 */
const DISCONNECTED = 'Disconnected'

/**
 * #### States
 *
 * Telsa has four internal states:
 *
 * - Connecting
 * - Handshaking
 * - Established
 * - Disconnected
 *
 * The following operations or events are *external* events
 * in terms of a state machine.
 * - `_write`
 * - `_final`
 * - `_read`
 * - socket error
 * - read path error when processing socket data, including:
 *   + tls protocol error, defined as alert description
 *   + operation errors returned from asynchronous operation
 *     * some errors are protocol error, such as certificate not verified
 *     * others are operation errors, such as child process crashed.
 *   + other exceptions
 * - write path error when executing `_write` operation:
 *   + all errors are exceptions (which is internal error in alert description)
 * - server alert
 *   + fatal alert
 *   + close_notify
 *   + other warning alerts other than close_notify
 * - close `without a server alert`
 *
 * #### Stateful Resources
 * - write path
 *   + if a `_write` operation cannot be performed immediately, it is blocked.
 *   + if the underlying socket `write` returns `false` during a `_write` operation.
 * - read path
 *   + the underlying socket may be paused
 *
 * #### Finish write path
 * - the underlying socket could be finished by `end` method.
 *
 * #### Finish read path
 * - the read path could be finished by push a null. This is only necessary
 * after the tls is connected.
 *
 * #### Connecting State
 *
 * In connecting state, only the following

#### `Connecting`

socket is connecting.

- `_write` is blocked.
- `_final` is allowed and triggers a transition to `Disconnected`.
- `_read` returns nothing.
- socket error triggers a transition to `Disconnected`; if there is `bufferredWrite`, error is passed via `callback`, otherwise, it is emitted.

#### `Handshaking`

- `_write` is blocked.
- `_final` triggers a transition to `Disconnected`. The callback is instantly invoked.
- socket error or message error triggers a transitoin to `Disconnected`.

#### `Established`
- `_write` is passed to socket connection. If blocking, the `callback` is blocked to next `Drain` event.
- `_final` triggers a transition to `Disconnected`; the callback is passed to underlying `socket.end()`.
- socket error or message error triggers a transitoin to `Disconnected`.

#### `Disconnected`
- `_write` returns error.
- `_final` succeeds anyway.
- `_read` returns nothing.
*/
class Telsa extends Duplex {
  /**
   * @param {object} opts
   */
  constructor (opts) {
    super(opts)

    /** options */
    this.opts = opts

    /**
     * blocked or draining `_write` operation
     * - `null` if no blocked `_write`
     * - `{ chunk, encoding, callback }` if a `_write` is blocked
     * - `callback` if the operation is waiting for draining
     * @type {object|function}
     */
    this.writing = null

    const onSocketErrorEarly = err => this.emit(err)

    /**
     * tcp connection
     * @type {net.Socket}
     */
    this.socket = net.createConnection(opts, () => {
      this.state = 'Handshaking'

      /**
       * incomming data buffer, may contain fragmented records.
       * @type {Buffer}
       */
      this.incomming = Buffer.alloc(0)

      /**
       * current fragment, contains 0, 1 or more records of the same type.
       * @type {Fragment}
       */
      this.fragment = null

      /**
       * handshake context
       * @type {HandshakeContext}
       */
      this.hs = new HandshakeContext()

      /**
       * @type {CipherFunction}
       */
      this.cipher = null

      /**
       * @type {DecipherFunction}
       */
      this.decipher = null

      this.socket.removeListener('error', onSocketErrorEarly)

      this.socket.on('error', err => this.handleError(err))
      this.socket.on('data', data => {
        try {
          this.handleSocketData(data)
        } catch (e) {
          this.handleError(e)
        }
      })

      this.socket.on('close', () => this.handleSocketClose())

      // start handshaking
      this.sendClientHello()
    })

    this.socket.once('error', onSocketErrorEarly)

    this.state = CONNECTING
  }

  /**
   * @return max fragment length
   */
  maxFragmentLength () {
    if (this.decipher) {
      return Math.pow(2, 14) + 2048
    } else {
      return Math.pow(2, 14)
    }
  }

  /**
   * read a record out of incomming data buffer
   * @returns {Fragment} the record type and payload
   */
  readFragment () {
    if (this.incomming.length < 1) return
    const type = this.incomming[0]
    if (type < 20 || type > 23) {
      throw new TLSError(DECODE_ERROR, 'bad content type')
    }

    if (this.incomming.length < 3) return
    const version = this.incomming.readUInt16BE(1)
    if (version !== 0x0303) {
      throw new TLSError(DECODE_ERROR, 'bad protocol version')
    }

    if (this.incomming.length < 5) return
    const length = this.incomming.readUInt16BE(3)

    if (length === 0) {
      throw new TLSError(DECODE_ERROR, 'zero record payload length')
    }

    if (length > this.maxFragmentLength()) {
      throw new TLSError(RECORD_OVERFLOW, 'record overflow')
    }

    if (this.incomming.length < 5 + length) return

    let data = this.incomming.slice(5, 5 + length)
    this.incomming = this.incomming.slice(5 + length)

    if (this.decipher) data = this.decipher(type, data)

    return { type, data }
  }

  /**
   * shift data chunk with given size from current fragment
   * @returns {Fragment}
   */
  shiftFragment (size) {
    if (!this.fragment || this.fragment.data.length < size) {
      throw new TLSError(DECODE_ERROR, 'bad fragment size')
    }

    const type = this.fragment.type
    const data = this.fragment.data.slice(0, size)

    if (size === this.fragment.data.length) {
      this.fragment = null
    } else {
      this.fragment.data = this.fragment.data.slice(size)
    }

    return { type, data }
  }

  /**
   * read a message from current fragment
   * @returns {Message}
   */
  readMessageFromFragment () {
    if (!this.fragment) return
    switch (this.fragment.type) {
      case ALERT:
        if (this.fragment.data.length < 2) return
        return this.shiftFragment(2)
      case CHANGE_CIPHER_SPEC:
        return this.shiftFragment(1)
      case HANDSHAKE: {
        if (this.fragment.data.length < 4) return
        const length = readUInt24(this.fragment.data.slice(1))
        if (this.fragment.data.length < 4 + length) return
        return this.shiftFragment(4 + length)
      }
      case APPLICATION_DATA:
        return this.shiftFragment(this.fragment.data.length)
      default:
        throw new TLSError(DECODE_ERROR, 'invalid content type')
    }
  }

  /**
   * read a message
   * @returns {Message}
   */
  readMessage () {
    while (true) {
      const msg = this.readMessageFromFragment()
      if (msg) return msg
      const frag = this.readFragment()
      if (!frag) return

      if (this.fragment) {
        if (frag.type !== this.fragment.type) {
          throw new TLSError(DECODE_ERROR, 'incomplete fragment')
        }
        this.fragment.data = Buffer.concat([this.fragment.data, frag.data])
      } else {
        this.fragment = frag
      }
    }
  }

  // TODO inline
  changeCipherSpec (key, macKey, iv) {
    this.sendChangeCipherSpec()
    this.cipher = createCipher(key, macKey, iv)
  }

  // TODO inline
  serverChangeCipherSpec (key, macKey) {
    this.decipher = createDecipher(key, macKey)
  }

  /**
   * handle socket data
   * @param {Buffer} data - socket data
   */
  handleSocketData (data) {
    this.incomming = Buffer.concat([this.incomming, data])
    while (true) {
      const msg = this.readMessage()
      if (!msg) return
      const { type, data } = msg
      switch (type) {
        case ALERT:
          this.handleAlert(data)
          break
        case CHANGE_CIPHER_SPEC:
          this.handleChangeCipherSpec(data)
          break
        case HANDSHAKE:
          this.handleHandshakeMessage(data)
          break
        case APPLICATION_DATA:
          this.handleApplicationData(data)
          break
        default:
          throw new TLSError(DECODE_ERROR, 'invalid content type')
      }
    }
  }

  /**
   * handle alert message, all warnings are bypassed except `close_notify`
   * @param {Buffer} data
   */
  handleAlert (data) {
    const level = data[0]
    const desc = data[1]

    if (level !== WARNING && level !== FATAL) {
      throw new TLSError(DECODE_ERROR, 'bad alert level')
    }

    if (level === FATAL || (level === WARNING && desc === CLOSE_NOTIFY)) {
      throw new TLSAlert(desc)
    } else {
      console.log(`telsa server alert "${alertDescription(desc)}"`)
    }
  }

  /**
   * handle handshake message
   * @param {Buffer} msg - full message data, including type, length, and body
   */
  handleHandshakeMessage (msg) {
    const type = msg[0]
    const data = msg.slice(4)

    switch (type) {
      case HELLO_REQUEST:
        // TODO may reply no_renegotiation
        return
      case CLIENT_HELLO:
        throw new TLSError(UNEXPECTED_MESSAGE, 'unexpected client hello')
      case SERVER_HELLO:
        this.handleServerHello(data)
        break
      case CERTIFICATE:
        this.handleCertificate(data)
        break
      case SERVER_KEY_EXCHANGE:
        throw new TLSError(UNEXPECTED_MESSAGE, 'unexpected server key exchange')
      case CERTIFICATE_REQUEST:
        this.handleCertificateRequest(data)
        break
      case SERVER_HELLO_DONE:
        this.handleServerHelloDone(data)
        break
      case CERTIFICATE_VERIFY:
        throw new TLSError(UNEXPECTED_MESSAGE, 'unexpected certificate verify')
      case CLIENT_KEY_EXCHANGE:
        throw new TLSError(UNEXPECTED_MESSAGE, 'unexpected client key exchange')
      case FINISHED:
        this.handleServerFinished(data)
        break
      default:
        throw new TLSError(DECODE_ERROR, 'bad handshake message type')
    }
    this.hs.push(msg)
  }

  /**
   * ```
   * struct {
   *   ProtocolVersion server_version;
   *   Random random;
   *   SessionID session_id;
   *   CipherSuite cipher_suite;
   *   CompressionMethod compression_method;
   *   select (extensions_present) {
   *     case false:
   *       struct {};
   *     case true:
   *       Extension extensions<0..2^16-1>;
   *   };
   * } ServerHello;
   * ```
   */
  handleServerHello (data) {
    const shift = size => K(data.slice(0, size))(data = data.slice(size))

    const ProtocolVersion = shift(2)
    if (!ProtocolVersion.equals(VER12)) {
      throw new TLSError(ILLEGAL_PARAMETER, 'unsupported tls version')
    }

    const Random = shift(32)
    this.hs.serverRandom = Random

    const SessionId = shift(shift(1)[0])
    this.hs.sessionId = SessionId

    const CipherSuite = shift(2)
    if (!CipherSuite.equals(AES_128_CBC_SHA)) {
      throw new TLSError(ILLEGAL_PARAMETER, 'unsupported cipher suite')
    }

    const CompressionMethod = shift(1)[0]
    if (CompressionMethod !== 0) {
      throw new TLSError(ILLEGAL_PARAMETER, 'compression not supported')
    }

    /**
    TODO new class ?
    console.log('ServerHello', {
      ProtocolVersion: ProtocolVersion.toString('hex'),
      Random,
      SessionId,
      CipherSuite: CipherSuite.toString('hex'),
      CompressionMethod,
      data
    })
*/
  }

  /**
   * ```
   * struct {
   *   ASN.1Cert certificate_list<0..2^24-1>;
   * } Certificate;
   * ```
   */
  handleCertificate (data) {
    const shift = size => K(data.slice(0, size))(data = data.slice(size))

    if (data.length < 3 || readUInt24(shift(3)) !== data.length) {
      throw new TLSError(DECODE_ERROR, 'invalid message length')
    }

    // certificates are in DER format and reversed order
    const ders = []
    while (data.length) {
      if (data.length < 3 || readUInt24(data) + 3 > data.length) {
        throw new TLSError(DECODE_ERROR, 'invalid cert length')
      }
      ders.push(shift(readUInt24(shift(3))))
    }

    // change to PEM format and reverse order
    const pems = ders.map(der => derToPem(der)).reverse()
    const pem = pems.pop()

    let failed = false
    let key = ''
    let verified = false

    verifyCertificateChain(pem, pems, this.opts.ca, (err, _verified) => {
      if (failed) return
      if (err) {
        failed = true
        this.handleError(err)
      } else {
        if (_verified) {
          verified = true
          success()
        } else {
          const err = new TLSUnknownCA('failed to verify certificate chain')
          this.handleError(err)
        }
      }
    })

    extractPublicKey(pem, (err, stdout) => {
      if (failed) return
      if (err) {
        failed = true
        this.handleError(err)
      } else {
        key = stdout.toString()
        success()
      }
    })

    const success = () => {
      if (key && verified) {
        this.hs.serverPublicKey = key
        this.sendClientCertificate()
      }
    }
  }

  /**
   * ```
   * struct {
   *   ClientCertificateType certificate_types<1..2^8-1>;
   *   SignatureAndHashAlgorithm
   *     supported_signature_algorithms<2^16-1>;
   *   DistinguishedName certificate_authorities<0..2^16-1>;
   * } CertificateRequest;
   * ```
   */
  handleCertificateRequest (data) {
    const shift = size => K(data.slice(0, size))(data = data.slice(size))
    if (data.length < 1 || data[0] + 1 > data.length) {
      throw new TLSError(DECODE_ERROR, 'invalid length')
    }

    this.hs.certificateTypes = Array.from(shift(shift(1)[0]))

    if (data.length < 2 || data.readUInt16BE() % 2 ||
      data.readUInt16BE() + 2 > data.length) {
      throw new TLSError(DECODE_ERROR, 'invalid length')
    }

    this.hs.signatureAlgorithms = Array
      .from(shift(shift(2).readUInt16BE()))
      .reduce((acc, c, i, arr) =>
        (i % 2) ? [...acc, arr[i - 1] * 256 + c] : acc, [])

    // ignore distinguished names (DER), observed 00 00

    /**
    console.log('CertificateRequest', {
      ClientCertificateType: this.hs.certificateTypes,
      SignatureAndHashAlgorithm: this.hs.signatureAlgorithms,
      data
    })
*/
  }

  /**
   * struct { } ServerHelloDone;
   */
  handleServerHelloDone (data) {
    if (data.length) {
      throw new TLSError(DECODE_ERROR, 'invalid server hello done')
    }
    process.nextTick(() => this.sendClientCertificate())
  }

  /**
   * checks `verify_data` in server Finished message, transits to
   * Established state or throw error
   *
   * ```
   * struct {
   *   opaque verify_data[verify_data_length];
   * } Finished;
   * ```
   * @param {Buffer} data
   */
  handleServerFinished (data) {
    // console.log(handshakeTypeName(this.hs.lastType()))

    console.log(this.hs.buffer.map(msg => handshakeTypeName(msg[0])))

    const verifyData = this.hs.serverVerifyData()
    if (!data.equals(verifyData)) {
      throw new TLSError(DECRYPT_ERROR, 'verified failed')
    }

    process.nextTick(() => {
      // exit Handshaking state
      delete this.hs

      // set state
      this.state = ESTABLISHED
      console.log('entering Established state')

      // enter Established state
      this.socket.on('drain', () => {
        if (this.writing) {
          const callback = this.writing
          this.writing = null
          callback()
        }
      })

      if (this.writing) {
        const { chunk, encoding, callback } = this.writing
        this.writing = null
        this._write(chunk, encoding, callback)
      }
    })
  }

  /**
   * handle change cipher spec
   */
  handleChangeCipherSpec (data) {
    // TODO expect
    console.log('handle change cipher spec', data)
    this.serverChangeCipherSpec(this.hs.serverWriteKey,
      this.hs.serverWriteMacKey)
  }

  /**
   * handle application data
   */
  handleApplicationData (data) {
    console.log('handle application data')
    if (this.state === ESTABLISHED) {
      // if (this.push(data))
    } else {
    }
  }

  /**
   * record layer send data
   * @param {number} type - content type
   * @param {Buffer} data - content
   */
  send (type, data, callback) {
    if (this.cipher) data = this.cipher(type, data)
    const record = concat([UInt8(type), VER12, Prepend16(data)])
    return this.socket.write(record, callback)
  }

  /**
   * @return {boolean} false if buffer full
   */
  sendAlert (level, description) {
    return this.send(ALERT, from([level, description]))
  }

  /**
   * @return {boolean} false if buffer full
   */
  sendChangeCipherSpec () {
    return this.send(CHANGE_CIPHER_SPEC, from([1]))
  }

  /**
   * @return {boolean} false if buffer full
   */
  sendHandshakeMessage (type, data) {
    console.log('sending: ' + handshakeTypeName(type))
    data = concat([UInt8(type), Prepend24(data)])
    this.hs.push(data)
    return this.send(HANDSHAKE, data)
  }

  /**
   * send ClientHello handshake message
   */
  sendClientHello () {
    this.sendHandshakeMessage(CLIENT_HELLO, concat([
      VER12,
      this.hs.clientRandom,
      from([0]), // session_id
      from([0x00, 0x02, 0x00, 0x2f]), // cipher_suites
      from([0x01, 0x00]) // compression_methods
    ]))
  }

  /**
   * send client certificate if ServerHelloDone and
   * server public key available (which also means server certificates
   * verified)
   */
  sendClientCertificate () {
    if (this.hs.serverPublicKey &&
      this.hs.lastType() === SERVER_HELLO_DONE) {
      this.sendHandshakeMessage(CERTIFICATE,
        Prepend24(concat([
          ...this.opts.clientCertificates.map(c => Prepend24(c))])))

      this.sendClientKeyExchange()
    }
  }

  /**
   * send ClientKeyExchange message, preMasterSecret is encrypted
   * using server's public key
   */
  sendClientKeyExchange () {
    this.sendHandshakeMessage(CLIENT_KEY_EXCHANGE,
      Prepend16(publicEncrypt({
        key: this.hs.serverPublicKey,
        padding: RSA_PKCS1_PADDING
      }, this.hs.preMasterSecret)))

    this.sendCertificateVerify()
  }

  /**
   * send CertificateVerify, ChangeCipherSpec, and client Finished
   */
  sendCertificateVerify () {
    const key = this.opts.clientPrivateKey
    if (typeof key === 'function') {
    } else {
      const sig = createSign('sha256').update(this.hs.tbs()).sign(key)
      this.sendHandshakeMessage(CERTIFICATE_VERIFY,
        concat([RSA_PKCS1_SHA256, Prepend16(sig)]))

      // change cipher spec
      this.hs.deriveKeys()
      const { clientWriteKey, clientWriteMacKey, iv } = this.hs
      this.changeCipherSpec(clientWriteKey, clientWriteMacKey, iv)

      // send finished
      this.sendHandshakeMessage(FINISHED,
        this.hs.clientVerifyData())
    }
  }

  /**
   * @return {boolean} false if buffer full
   */
  sendApplicationData (data, callback) {
    console.log('sending: application data')
  }

  /**
   * implements `Duplex` `_write`
   */
  _write (chunk, encoding, callback) {
    switch (this.state) {
      // fallthrough
      case CONNECTING:
      case HANDSHAKING:
        this.writing = { chunk, encoding, callback }
        break
      case ESTABLISHED:
        if (this.sendApplicationData(chunk)) {
          callback()
        } else {
          this.writing = callback
        }
        break
      case DISCONNECTED:
        callback(new Error('disconnected'))
        break
      default:
        break
    }
  }

  /** implement Duplex _final */
  _final (callback) {
    switch (this.state) {
      case CONNECTING: {
        this.socket.removeAllListeners()
        this.socket.on('error', () => {})
        this.socket.end()
        callback()
        this.state = DISCONNECTED
      } break
      case HANDSHAKING: {
        this.socket.removeAllListeners()
        this.socket.on('error', () => {})
        // TODO send close_notify
        this.socket.end()
        this.state = DISCONNECTED
        callback()
      } break
      case ESTABLISHED: {
        // TODO
      } break
      case DISCONNECTED: {
        callback()
      } break
      default:
        break
    }
  }

  /** implement Duplex _read */
  _read (size) {
    if (this.state === ESTABLISHED) this.socket.resume()
  }

  /**
   * This function handles error in Handshaking and Established states.
   *
   * All errors trigger a transition to `disconnected` state.
   * 1. send fatal alert or close_notify warning if necessary
   * 2. clean up all event handlers and end underlying socket
   * 3. clean up write path:
        if there ar blocking or draing write, pass error throught callback
   *    otherwise emit error
   * 4. clean up read path if connection established
   * 5. trigger a close if connection established
   */
  handleError (err) {
    // 1. ERR_TLS_CLOSE_NOTIFY
    // 2. ERR_TLS_ERROR (with description)
    // 3. ERR_TLS_ALERT (with description)
    // 4. ERR_TLS_SOCKET_CLOSE
    // 5. Otherwise, it's a socket error
    //
    // In case 3, 4 and 5, there is no chance to send any message
    // In case 2, a fatal alert should be sent
    // In case 1, a reply close_notify should be sent
    //
    // 2/3/4/5 are error state. 1 may be OK if no pending or draing write
    //
    // In all cases, if pending or draing write exists
    // for case 1, EPIPE with This socket has been ended by the other party
    // for others, orignal error is returned via callback.
    //
    // If no pending or draining write
    // for 2/3/4/5, error is emitted
    //
    //                                              handshaking   established
    // step 1. write things if required             Y             Y
    // step 2. clean up socket if necessary         Y             Y
    // step 3. finish read path for close_notify    N             Y
    // step 4. emit or callback error               Y (all)       Y (not close_notify)
    // step 5. close                                N             Y

    if (err.code === 'ERR_TLS_CLOSE_NOTIFY') {
      // send close notify
    }

    if (err.code === 'ERR_TLS_FATAL_ERROR') {
      // send fatal alert
    }

    // TODO open-close
    this.socket.removeAllListeners()
    this.socket.on('error', () => {})

    // end read path
    if (this.state === ESTABLISHED) this.push(null)

    if (this.writing) {
      const error = err.code === 'ERR_TLS_CLOSE_NOTIFY'
        ? Object.assign(new Error('other party'), {})
        : err
    }

    if (err instanceof TLSCloseNotify) {
      this.socket.removeAllListeners()
      this.socket.on('error', () => {})
      this.socket.on('close', () => this.emit('close'))

      // TODO write
      this.socket.end()

      // write path
      if (this.writing) {
        const callback = this.writing
        this.writing = null
        callback(new Error('server close'))
      }

      // read path
      this.push(null)

      this.state = DISCONNECTED
      return
    }

    switch (this.state) {
      case CONNECTING:
        break
      case HANDSHAKING:
        break
      case ESTABLISHED: {
      } break
      default:
        break
    }
  }
}

module.exports = Telsa
