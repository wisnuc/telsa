# Overview

`telsa` is a lightweight tls implementation supporting hardware crypto integration. It is specifically designed for aws iot devices with crypto chips, such as Microchip/Atmel ATECC508a/608a.



`openssl` supports third-party crypto by openssl engine. Theoretically, this should be the proper way to integrate a crypto hardware with openssl and node. In practice, however,

1. Microchip does not provide a proper linux driver;
2. The openssl engine provided by Microchip is outdated and not actively maintained;
3. Node statically links openssl and updates version frequently over evolution;

This leaves application developers a great headache to assure the compatibility among driver, openssl, and node. So we decide to develop a standalone tls implementation independent of openssl and node.



`telsa` merely meets the minimal requirement by aws iot:

1. tls 1.2 only 
2. support only one cipher, `TLS_RSA_WITH_AES_128_CBC_SHA`
3. `Certificate Request` is mandatory. This is optional in tls spec but mandatory for aws iot server



A tls implementation requires processing x509 certificates, including:

- conversion between different certificate format, such as DER or PEM
- extraction of public key
- verification of certificate chain

These jobs are mainly performed by `openssl` command, keeping `telsa` to be small and simple. For an iot device without user login or third-party services, the security risk is acceptable.



`telsa` is written in JavaScript. The performance should be more than enough for a mqtt client. But it is not recommended for data communication with heavy load. 



`telsa` is self-contained. There is no other dependencies except the `openssl` command mentioned above. 



# Use Case and Constraints

## Use case

`telsa` is going to be used with [`mqtt`](https://github.com/mqttjs/MQTT.js) and [`aws-iot-device-sdk`](https://github.com/aws/aws-iot-device-sdk-js).



According to [`mqtt document`](https://github.com/mqttjs/MQTT.js#mqttclientstreambuilder-options), the underlying transport (connection) could be anything implementing a node `Stream` class and supporting `connect` event. The developer can provide its own `streamBuilder` which returns a `connection`.



In `aws-iot-device-sdk`, [the following code](https://github.com/aws/aws-iot-device-sdk-js/blob/master/device/lib/tls.js) creates a `streamBuilder` for node tls.

```javascript
var tls = require('tls');

function buildBuilder(mqttClient, opts) {
   var connection;

   connection = tls.connect(opts);

   function handleTLSerrors(err) {
      mqttClient.emit('error', err);
      connection.end();
   }

   connection.on('secureConnect', function() {
      if (!connection.authorized) {
         connection.emit('error', new Error('TLS not authorized'));
      } else {
         connection.removeListener('error', handleTLSerrors);
      }
   });

   connection.on('error', handleTLSerrors);
   return connection;
}

module.exports = buildBuilder;
```



node `tls` is a subclass of `net.Socket`. `net.Socket` has its own `connect` event, indicating a tcp connection is established. `tls` adds a `secureConnect` event to indicate a tls handshake is successful.



`aws-iot-device-sdk` does not block the `connect` event and translate `secureConnect` to the `connect` event required by `mqttClient`. This is not a problem since the tls could cache the written data when a secure connection has not been established. It just hooks an error handler on connection, handling any error occurred before `secureConnect` by emitting an error directly via `mqttClient.emit` (since the connection is not available yet). If the connection is established without proper authorization, the error is emitted via `connection.emit`. For `mqtt`, this error is emitted well after the `connect` event (tcp connection). After the connection is properly authorized, the error handler is removed and all subsequent errors are handled by `mqttClient`.



## Interface Definition

`telsa` is not designed to be an drop-in replacement for node tls. Instead, it merely supports the requirement by `mqtt`, which means:

- `connect` event is supported and indicates a secure connection is established
- `secureConnect` event in node tls is not supported
- `lookup`, `ready`, and `timeout` events in `net.Socket` are not supported
- All `stream.Readable` and `stream.Writable` events are supported. This is implemented by subclassing `stream.Duplex`.
  - `writable._write`
  - `writable._writev` , not implemented
  - `writable._final`
  - `readable._read`
  - `writable._destroy` & `readable.destroy`
  - the following events supported by `stream.Readable` and `stream.Writable`  are not concern since they are implemented by `stream.Duplex`, as long as above methods are properly implemented and the `readable.push` is properly used.
    + `writable.close`
    + `writable.drain`
    + `writable.finish`
    + `writable.pipe`
    + `writable.unpipe`
    + `readable.close`
    + `readable.data`
    + `readable.end`
    + `readable.readable`

This list is the interface spec definition for `tesla`.

### `telsa.connect`



## Duplex Stream Error Handling

For implementing `stream.Writable`, node documents has the following advice for error handling:

> **Errors While Writing**
>
> It is recommended that errors occurring during the processing of the `writable._write()` and `writable._writev()` methods are reported by invoking the callback and passing the error as the first argument. This will cause an `'error'` event to be emitted by the `Writable`. Throwing an `Error` from within `writable._write()` can result in unexpected and inconsistent behavior depending on how the stream is being used. Using the callback ensures consistent and predictable handling of errors.



For implementing `stream.Readable`, node documents has the following advice for error handling:

> **Errors While Reading**
> 
> It is recommended that errors occurring during the processing of the `readable._read()` method are emitted using the `'error'` event rather than being thrown. Throwing an Error from within `readable._read()` can result in unexpected and inconsistent behavior depending on whether the stream is operating in flowing or paused mode. Using the `'error'` event ensures consistent and predictable handling of errors.

For other errors not occurred during `writable._write()` or `readable._read()`, emitting the error is the proper way.



## Record Protocol

TLS is split into two layers. The lower layer is the TLS Record Protocol and the upper layer includes four protocols:

- the handshake protocol
- the alert protocol
- the change cipher spec protocol
- the application data protocol



## Write Path

Write path starts from an invocation of `_write` or `_final` function. Invocations are serialized via `callback` arguments. The following possible states:

- idle, not invocation and not ended.
- pending, the underlying stream is temporarily unavailable. `chunk`, `encoding`, and `callback` are cached.
- draining, the data chunk has been written to the underlying stream and waiting for `drain` event is required. `callback` is cached.
- ending,  `_final` is invoked.
- ended, `_final` has been invoked.  



## Read Path

Read path starts from a `data` event from the underlying stream. If application data is generated, it is passed to upper layer via `readable.push()`. If this function returns false, the underlying stream is paused, until a `_read()` from the upper layer.

- flowing
- paused



## Renegotiation

If the client starts a renegotiation, it is possible some application data are received when expecting a ServerHello message. A timeout is required for Hello state.



If the server starts a renegotiation, a HelloRequest is sent to the client. According to rfc document, the server should not send HelloRequest again. But the document does not mentioned whether the server could send application data after a HelloRequest message. We assume that this is possible. So a time out is also required in Hello state.



When the client received a HelloRequest, it should transit to Hello state immediately. In Hello state `enter` method:

- if the write path is in draining state, the `callback` should be called immediately.
- if the read path is in paused state, it should be resumed.



Renegotiation is not implemented in current version. But the possibility should be taken into account for state design.



## Closing

Closing a tls session may be initiated from either party by sending a `close_notify` alert to the other. 




> Unless some other fatal alert has been transmitted, each party is required to send a `close_notify` alert before closing the write side of the connection.  The other party MUST respond with a `close_notify` alert of its own and close down the connection immediately,  discarding any pending writes.  It is not required for the initiator of the close to wait for the responding `close_notify` alert before closing the read side of the connection.



The first sentence means the initiator should send a `close_notify` before invoking `end` of the underlying stream.

The second sentence says the responder should reply with a `close_notify` then invoking `end` of the underlying stream immediately.

The third sentence indicates that the initiator could discard the incoming data and close the underlying stream immediately, without waiting for the responding `close_notify` alert.



> If the application protocol using TLS provides that any data may be carried over the underlying transport after the TLS connection is closed, the TLS implementation must receive the responding close_notify alert before indicating to the application layer that the TLS connection has ended. If the application protocol will not transfer any additional data, but will only close the underlying transport connection, then the implementation MAY choose to close the transport without waiting for the responding close_notify. No part of this standard should be taken to dictate the manner in which a usage profile for TLS manages its data transport, including when connections are opened or closed.
>
> Note: It is assumed that closing a connection reliably delivers pending data before destroying the transport.



The first sentence says if the underlying stream carries not only a single TLS connection, the initiator should wait for the responding `close_notify` and emit a `close` to the upper layer until it arrives. 

The second sentence says if the underlying stream is dedicated for a single TLS connection, which is our case, the initiator may close the transport immediately without waiting for the responding `close_notify`.

The last note says, in our case, `end` should be used to close the connection, rather than a `destory`.



Noticing that in TLS, there is no half-open connection, unlike a tcp connection. A clean up could be done synchronously.



Also, a race condition may occur. The two parties send `close_notify` alerts at almost the same time. There is no way to differentiate whether the received `close_notify` is a response after the other party has received the alert, or before it receives the alert.



In implementation, such a race condition could be avoided since the initiator is allowed to close the underlying stream immediately after sending a `close_notify`, without waiting for a reply.



When the upper layer invokes the `end` method, `_final` function is called. In this function, we can:

1. send a `close_notify` to the other party.
2. clean up all listeners and mute error.
3. invoke the `end` function with the `callback`.
4. invoke the `readble.push` with `null` to close the connection.

In this way, even if there are incoming fatal alert or `close_notify`, the initiator won't bother, which means, as long as the upper layer initiates a close, the TLS layer stops immediately and synchronously. The upper layer could only receive an error if the underlying stream could not flush the outgoing data.



If a `close_notify` arrives first, we can:

1. reply a `close_notify` to the other party immediately.
2. if there are pending or draining write, trigger the `callback` with an error.
3. invoke the readable.push with null to close the connection.

After this steps, the tls is marked as finished. a write in this state is replied with an error. an end in this state is OK.



Summary:

1. there is no additional transient state required, such as disconnecting, etc.
2. close could be initiated from either side. In both case, the tls machine stops synchronously.










1. `_final` is called. A close notify is sent from the client to the server.
2. a close notify is received from the other party.
   1. For tls
      1. a close notify is replied.
      2. clean up socket handlers, including `close`.
   2. write path
      1. if the state is pending or draining, the callback is triggered with an error (a server close).
      2. if the state is finalizing, the callback is called without an error. **
   3. read path
      1. the readable.push is called to close the stream.



# Error Handling

Invocation or event sources:

1. method invocation by upper layer.
2. underlying layer's `data` event handler
3. asynchronous callback



All invocation or event sources should be try/catch-ed.



Record Layer should be as robust as possible. If an error is thrown from the upper layer, it is possible to send a fatal alert before destroying the underlying stream.



Data handler could detect finished state and abort further processing.



All state object should be  



destroy may happens anytime.





# Design

## Layered Structure

TLS layer sits between an duplex stream implementation and a tcp connection (`net.Socket`).



```
----------------------------
  handshake, change cipher spec, alert
----------------------------
  record protocol
----------------------------
  socket
----------------------------
```



## socket

The record protocol layer use the following interface provided by socket

- write path
  - `write` and `end` method
  - `drain` event
- read path
  - `pause` and `resume` method
  - `data` and `close` event
- error handling
  - `error` event
- destroy (?)
  - `destroy` method



## the record protocol

The record protocol provides the following interface to upper layer protocols:

* write path
  * write and end method
  * drain event
* read path
  * pause and resume method
  * data frame (type, data?) and close event
* configuration (set context?)
* error handling
  * error event
* destroy (?)
  * destroy method







```javascript
class Telsa extends stream.Duplex {
    constructor () {
        super()
    }
    
    connect () {
        
    }
    
    _write () {
        
    }
}
```











```
tls
```









`telsa` is implemented with a hierarchical state machine. There is a `context` object as the context and a bunch of `state` objects representing the sub-states:

```
state class
------------------------------------------------------------------------------------------
State                                       | base state
  InitState*								| idle state
  Connecting*
  Connected (socket and rp)
    HandshakeState (handshake context)
      ServerHello*
      ServerCertificate*
      CertificateRequest*
      ServerHelloDone*
      VerifyServerCertificates*
      CertificateVerify*
      ChangeCipherSpec*
      ServerFinished*
    Established*
  FinalState*
```

|state class|Comment|
|-|-|
|State|base|
|InitState|initial state (idle)|
|Connecting|socket connecting|
| Connected                                                    |socket connected|
|HandshakeState|handshaking state has a context|
|ServerHello|send CLIENT_HELLO and expect SERVER_HELLO|
|ServerCertificate|expect SERVER_CERTIFICATE, store server certificates and public key in handshake context. verification is deferred to VerifyServerCertificates to avoid parallel processing.|
|CertificateRequest|expect CERTIFICATE_REQUEST. Data format is checked but the content is not used.|
|ServerHelloDone|expect SERVER_HELLO_DONE|
|VerifyServerCertificates|verify server certificates|
|CertificateVerify|1. calc signature<br/>2. send CERTIFICATE_VERIFY<br/>3 change client cipher spec, send finished.|
|ChangeCipherSpec|expect server change cipher spec|
|ServerFinished | expect server finished|
|Established|communication|
|FinalState||




## RecordProtocol

RP单独封装为一个Class，










## State Machine

```

```





​	





UML状态图（State Diagram）是编程中最常使用的描述状态机的方式。该表示方法最初是由David Harel在1987年的论文，*Statecharts: A Visual Formalism for Complex Systems*，中提出的，所以它也常被称为**Harel Statechart**；个人更喜欢称之为**Harel Machine**。

在Harel Machine中，







In a Harel machine, common properties and behaviors among **concrete states** are further abstracted to **super states**, effectively transforming a flat state space into a hierarchical structure, with less states defined and much cleaner to understand.

The hierarchical tree consist of state as its node. Concrete states are the leaf nodes in the tree and super states are non-leaf ones. At any time, the module must live in a concrete state. All state node along the path, from root to leaf, collectively represents the full state of the module. 

A module cannot live in a super state alone, since a super state is merely an abstraction of common properties among several concrete states. Without a concrete state, a super state and it's  ancestors can NOT describe the state of the module in full detail.

For a given module, the Harel machine is usually quite easy to design and understand in the form of a UML state diagram. 

In real world programming, however, only the **flat machine** is easy to code. A flat machine is the simplest form of a Hierarchical machine, where there is only one level of hierarchy, that is, a single super state and several concrete states as its children. The famous state pattern of GoF is a good example. In this pattern, each state is implemented as a dedicated class. The hierarchical relationship is encoded by the class inheritance.

While it's convenient to program behavior using class inheritance for the state hierarchy, for all resources are located in one object and methods can easily be reused or overridden, it is a non-trivial job to correctly implement the `exit` and `enter` behavior during state transiton in a multiple level hierarchy. In the language that early-binds the class method, such as C++ or Java, the inheritance behavior of these methods conflicts to the `exit` and `enter` execution sequence required by the state transition in a multiple level hierarchical state machine.

For JavaScript, this is not the case, because JavaScript is a late-binding language. Even if there are inheritance relationship along the prototypal chain, we can avoid calling `exit` and `enter` using `this` keyword and dot notation. Instead, we can traverse the prototypal chain, **cherry-pick** the method, and execute it using `Function.prototype.apply` method. This is essentially a manual and forceful binding and invocation of the function. The required invocation sequence of `exit` and `enter` methods can be achieved in a very simple form. The only sacrifice is that these two methods cannot be invoked in the code elsewhere. But this is not a rule too painful to live with.

This is not the only problem to be solved in implementing a multiple level hierarchical state machine. But it is the most crucial one.

In short, this module implements a state pattern well supporting multiple level hierarchy. With very few rules and tricks, constructing and maintaining the state hierarchy is simple and practical. Of course the code won't look as simple as the simple composition of asynchronous functions or event emitters. But the extra burden are reasonable and the reward is huge.

State machine is not only a rigorous and complete mathematical model of software behaviours, it is also a model intrinsically immune to asynchrony and concurrency. The error handling is robust and graceful. Unlike the flat machine, a hierarchical machine is much easier to change or extend, due to it's capability of supporting multiple level of super states. Inserting a new layer of abstraction is not uncommon when requirement changes. This kind of change involves very few code modification in this pattern. We can safely claim that the hierarchical state pattern is more flexible than a frequently used flat one. In the flat machine, either the abstraction is inadequate, or the further abstraction is encoded in variable and dispatched in `switch` clause, which is hard to read and modify.

## Flat State Machine

Let's start with a flat machine. 

In classical state pattern (GoF), context and states are implemented by separate classes. All state-specific resources are maintained in state class. The context class holds global resources and simply forwards all external requests to it's state class.

Each state class has `enter` and `exit` methods for constructing and destructing state-specific resources/behaviors respectively. This is a powerful way to ensure the allocation and deallocation of resources, as well as starting and stoping actions, possibly asynchronous and concurrent, to happen at the right time and place.

The iconic method of state class (and the state pattern) is the `setState` method. It destructs the current state by calling `exit` method, constructs the new state, and calls its `enter` method.

> If you are not familiar with state pattern, I recommend you to read GoF's classical book, _Design Patterns_, or Google state pattern to have a solid knowledge of this pattern. This article assumes you are familiar with it.

```js
class State {
  constructor (ctx) {
    this.ctx = ctx
  }

  enter () {}
  exit () {}

  setState (NextState, ...args) {
    this.exit()
    this.ctx.state = new NextState(this.ctx, ...args)
    this.ctx.state.enter()
  }
}

class ConcreteState extends State {
  constructor (ctx, ...args) {
    super(ctx)
  }
}

class Context {
  constructor () {
    this.state = new ConcreteState(this)
    this.state.enter()
  }
}
```

### `setState`

In this pattern, the first parameter of the `setState` method is a state class constructor. 

In JavaScript, a class is modeled as a pair `(c, p)`, where `c` is the constructor function (aka, class name) and `p` is a plain object (prototype). There are built-in, mutual references between `c` and `p`:

1. `c.prototype` is `p`
2. `p.constructor` is `c`

This can be verified in a node REPL:

```
> class A {}
undefined
> A.prototype.constructor === A
true
```

So either `c` or `p` can be used to identify a class. `c` is more convenient for it's a declared name in the scope.

Sometimes, it is possible to eliminate the `enter` method and merge its logic into constructor for simplicity. 

Similarly, we can call `this.enter(...args)` inside the base state class constructor. Then in most cases, concrete state classes does not need to have a constructor. Implementing `enter` and `exit` methods is enough. The code looks a little bit cleaner.

But both simplification are not recommended unless the logic is really simple. Constructor is where to set up the **structure** of the object while `enter` is where to start the **behaviors**. They are different. Supposing the (context) object is observed by another object which want to _observe_ a state `entering` event. Then there is no chance for it to do so if constructor and `enter` are merged.

### A Pitfall

This flat state machine pattern is sufficient for many real world use cases. And I'd like to explain a critical pitfall of this pattern here, though it is irrelevant to the hierarchical state pattern which is going to be discussed later.

Supposing the context class is an event emitter and its state change is observed by some external objects. It emits `entering`, `entered`, `exiting` and `exited` with corresponding state name. Obviously the best place to trigger the context's `emit` method is inside `setState`:

```js
setState (NextState, ...args) {
  this.ctx.emit('exiting', this.constructor.name)
  this.exit()
  this.ctx.emit('exited', this.constructor.name)

  let next = new NextState(this.ctx, ...args)
  this.ctx.state = next

  this.ctx.emit('entering', next.constructor.name)
  this.ctx.state.enter()
  this.ctx.emit('entered', next.constructor.name)
}
```

The danger occurs when `setState` is immediately called again inside next state's `enter` method. In this case, the `setState` and `enter` methods are nested in the calling stack. `entered` event will be emitted in a last-in, first-out manner. The observer will receive `entered` in reversed order.

We have two solutions here.

One solution is to invoke `setState` with `process.nextTick()` in `enter`. In this way, an **maybe** state is allowed in design. This solution is simple and intuitive. But the unnecessary asynchrony may rise problem in complex scenarios.

> A **maybe** state is a state when entered, may transit to another state immediately, depending on the arguments.

In the other solution, the **maybe** state is strictly forbidden in design. The next state must be unambiguously determined before exiting a state. Conditional logics should be encapsulated by a **function**, rather than inside a state's `enter` method, if the logic is going to be used in many different code places. This is the **recommended** way. It avoids unnecessary asynchrony by `process.nextTick()`.

The importance of the second solution arises when many state machines, possibly organized into a list or tree, shares another larger context. Or we may say it's a **composition** of state machines.

In such a scenario, `process.nextTick()` is frequently used to defer or batch an composition-wise operation, such as reschedule certain jobs, when responding to an exteranl event and many state machines are transitting simultaneously. It avoids the job being triggered for each single state machine transition. If `nextTick()` is allowed for a single state machine transition, it is difficult for the composition context to determine at what time all those `nextTick()` finishes and the composition-wise deferred or batch job can begin.

> Of course all `process.nextTick` can be tracked. But it is a non-trivial job. It requires a composition-wise counter, which is incremented before calling `process.nextTick` in a single state machine, and decremented after each nextTick-ed job is finished.

### Re-entry

`setState` can be invoked with the same state constructor.

Denoting an object of `ConcreteState1` class as `s1`:

```js
s1.setState(ConcreteState1)
```

This invocation will invoke `s1.exit`, constructing a `next` object of the same class, and invoke `next.enter`.

In some cases, this behavior is tremendously useful. It immediately abandons all current jobs and deallocates all resources, then re-creates a brand-new state object. If we want to retry something or restart something under certain circumstances, this one-line code will tear down then set up everything like a breeze, providing the `enter` and `exit` methods are properly implemented. 

It is also possible to hand over something between two state object of the same class, for example, retried times. They can be passed as the argument of `setState`. If the logic requires a job to be retried again and again until certain accumulated effect reaches a critical point, this pattern is probably the best way to do the job. 

If the re-entry behavior is not required and harmful if triggered unexpectedly, you can check and forbid it in the `setState` method.

### Initialization and Deinitialization

The code constructing the first state (usually named `InitState`) object inside context constructor looks natural and trivial.

```js
this.state = new ConcreteState(this)
this.state.enter()
```

But this is duplicate logic with the latter half of `setState`. If more logics are added to `setState`, such as triggering the event emission, they must also be copied to context constructor.

Essentially, `setState` is a batch job. It destructs the previous state and constructs the next one. Initialization is just a special case where previous state is `null` and deinitialization is the opposite case where next state is `null`.

At first thought, `setState` is a class method and a `null` object cannot have any method. However, this is **NOT** true in late-binding JavaScript.

Reference to the class method can be retrieved through it's prototype, so it can be applied to a `null`, something like:

```js
State.prototype.setState.apply(null, [InitState])
```

In practice, context object is a required parameter for constructing the state object, so we replace `null` with the context object.


```js
// in state class
setState (NextState, ...args) {
  if (this instanceof State) {
    this.ctx.emit('exiting', this.constructor.name)
    this.exit()
    this.ctx.emit('exited', this.constructor.name)
  }

  if (NextState) {
    let ctx = this instanceof State ? this.ctx : this
    let next = new NextState(ctx, ...args)
    this.ctx.state = next

    this.ctx.emit('entering', next.constructor.name)
    this.ctx.state.enter()
    this.ctx.emit('entered', next.constructor.name)
  }
}

// In context class constructor
State.prototype.setState.apply(this, [InitState])
```

Although looks weird, this code makes sense and truly implements the DRY principle. 

> IMHO, it also reveals that in JavaScript, nothing is `static` in the sense of that in Java. The implementation of `static` keyword in ES6 is probably a mistake, for it installs the `static` members onto constructor `c`, rather than the prototype object `p`.

In most cases, the deinitialization (passing `null` as `NextState`) is not used. 

Explicitly constructing a final/zombie state (usually named `FinalState`) is far more practical. A state object can accept all methods from context object. Either ignoring the action (eg. do nothing when `stream.write` is called) or returning an error gracefully, is much better than throwing an `TypeError`.

### Builder Pattern

If the context object is an event emitter and its state change is observed, and if the state object is constructed inside the context constructor, the observer will miss the first state's `entering` or `entered` event.

In node.js official document, it is recommended to emit such an event via `process.nextTick()`. As discussed above, this faked asynchrony is unnecessary. It may poses potential problem in state machine composition.

The buider pattern perfectly fits this requirement. It is also very popular in node.js, such as event emitters and streams.

The context class should provide an `enter` method, where the first state object is constructed. A factory method is also recommended. Then we can have a familiar code pattern for constructing a context object.

```js
let x = createContextObject(...)
  .on('entering', state => {...})
  .on('entered', state => {...})
  .on('exiting', state => {...})
  .on('exited', state => {...})
  .enter()
```

> `enter` is just a example word here. In real world, it should be a word conforming to semantic convention. For example, a duplex stream may start its job by `connect` method, just like `net.Socket` does.

## Hierarchical State Machine

Now we can have a talk on how to construct a hierarchical state machine in JavaScript.

A real benefit of Harel machine is that the `enter` and `exit` logic are distributed into several layered states. Besides the top-level base state, there are intermediate layers of abstract states. Each intermediate state, or super state, can hold a sub-context and have behaviors of its own.

Supposing we have the following state hierarchy:

```
     S0 (base state)
    /  \
   S1  S2
  /  \
S11  S12
```

When transitting from S11 to S12, the `setState` should execute `S11.exit` and `S12.enter` sequentially. When transitting from S11 to S2, the sequence should be `S11.exit`, `S1.exit` and `S2.enter`.

Generally speaking, when transitting from concrete state Sx to Sy, there exists a common ancester (super state) denoted by Sca:

1. from Sx (inclusive) to Sca (exclusive), execute `exit` method in bottom-up sequence
2. from Sca (exclusive) to Sy (inclusive), construct and execute `enter` method in top-down sequence

In implementation, there are two ways to construct such a hierarchy. It can be implemented using a tree data structure with mutual references as `parent` and `children[]` properties.

This pattern is versatile but very awkward. It has the following pros and cons.

1. [Pro] the up-and-down sequence of calling `exit` and `enter` is straightforward.
2. [Pro] the sub-context are well separated in different object, so there is no name conflicts.
3. [Con] there is no inheritence between higher layer states and lower layer ones. It's painful to implement behaviors since functions and contexts are spreaded among several objects.

The first two pros can hardly balance the last con in most cases.

Another way is using class inheritance to construct the hierarchy as the classical state pattern does. Two problems arise immediately.

First, all super state's sub-context and the concrete state's state-specific things are merged into a single object, the object's properties must be well designed to avoid name conflict.

Second, the inheritance feature of `enter` and `exit` methods must NOT be used. Instead, the up-and-down sequence of `exit` and `enter` is implemented by a manual iteration along the prototypal inheritance chain and these two methods are invoked manually without inheritance behavior.

### State Class Constructor

In flat state machine, the first parameter of the constructor is the context object. This is OK if there's only global context for all states. 

In hierarchical state machine, however, each super state has its own sub-context which may need to be preserved during transition. For example, when transitting from S11 to S12 state, the S1-specific context should be preserved. This requirement can be implemented in the following method.

First, the first parameter of base class constructor should be changed from the global context object to the previous state object. A state object has all contexts inside it, either global or specific to certain super state.

Second, considering the initialization discussed in flat state machine, when constructing the first state, there is no previous state object but the global context object is required. So the type of the first parameter of the base class constructor should be `State | Context`.

```js
class State {
  constructor (soc) {
    this.ctx = soc instanceof State ? soc.ctx : soc
  }
}
```

In the constructor of a super state, if the first argument is an context object, or the first argument is an state object, but is NOT a descendant of this state, in either case, a new sub-context should be created. Otherwise, the old sub-context should be copied.

```js
class SuperState1 extends State {
  constructor (soc) {
    super(soc)
    if (soc instanceof SuperState1) {
      this.ss1 = soc.ss1
    } else {
      // constructing a new sub context
      this.ss1 = {
        ...
      }
    }
  }
}
```

Noticing that the `ss1` property is `SuperState1`-specific. Be careful to choose a unique name and avoid conflicts.

In JavaScript, constructing a sub-class object using `new` keyword always calls the constructors in the top-down sequence along the inheritance chain. This cannot be modified.

> It is possible to hijack some constructor's behavior via `return`. But this is error prone and is not suitable here.

Keep in mind that the only purpose of the super state's constructor, is to create a new sub-context, or to **take over** an old one. Nothing else should be done here. Considering the S11->S12 transition, S1's constructor is invoked inevitably. If any `enter` logic is merged into constructor it will be run during this transition, which is wrong and must be avoided.

> Again, _constructor constructs structure and `enter` starts behavior_.

### `setState`

`setState` is tricky and unusual in hierarchical state machine, but is not difficult. 

Modern JavaScript provides an `Object.getPrototypeOf()` method to replace the non-standard `__proto__` property for accessing the prototypal object of any given object.

`Function.prototype.apply()` is used to apply the `enter` or `exit` methods along inheritance chain onto `this` object. If a super state has no `enter` or `exit` method of its own, it is skipped.

```js
  setState (NextState, ...args) {
    let p = State.prototype
    let qs = []

    for (p = Object.getPrototypeOf(this);
      !(NextState.prototype instanceof p.constructor);
      p.hasOwnProperty('exit') && p.exit.apply(this),
      p = Object.getPrototypeOf(p));
  
    let ctx = this instanceof State ? this.ctx : this
    let nextState = new NextState(this, ...args)
    ctx.state = nextState

    for (let q = NextState.prototype; q !== p;
      q.hasOwnProperty('enter') && qs.unshift(q),
      q = Object.getPrototypeOf(q));

    qs.forEach(q => q.enter.apply(ctx.state))
  }
```

### Initialization

Similar with that in flat state machine, we can encapsulate the construction and destruction of state object solely in `setState`. Here we have even more benefit for the construction logic is more complex.

```js
  setState (NextState, ...args) {
    let p = State.prototype
    let qs = []

    if (this instanceof State) {
      for (p = Object.getPrototypeOf(this);
        !(NextState.prototype instanceof p.constructor);
        p.hasOwnProperty('exit') && p.exit.apply(this),
        p = Object.getPrototypeOf(p));

      this.exited = true
    }

    if (NextState) {
      let ctx = this instanceof State ? this.ctx : this
      let nextState = new NextState(this, ...args)
      ctx.state = nextState

      for (let q = NextState.prototype; q !== p;
        q.hasOwnProperty('enter') && qs.unshift(q),
        q = Object.getPrototypeOf(q));

      qs.forEach(q => q.enter.apply(ctx.state))
    }
  }

// in context constructor or enter
State.prototype.apply(this, [InitState])
```

### Error Handling



## Summary

I will give some complete examples in coming days.

In short, an easy-to-understand and easy-to-use state machine pattern is invaluable for software construction, especially in the world of asynchronous and concurrent programming.

JavaScript and node.js perfectly fits the need.

The pattern discussed above are heavily used in our products. They evolves in several generations and gradually evovles into a compact and concise pattern, fully unleashing the power of JavaScript. Similar pattern implemented in other languages requires far more boiler-plate codes. And certian tricks cannot be done at all.

This is the first half and basic part of programming JavaScript concurrently, either in Browser or in Node.js. The hierarchical state machine discussed here can handle any kind of intractable concurrent problem as long as it could be modeled as a single state machine.

Both event emitter and asynchronous functions with callback are just degenerate state machines. A thorough understanding of state machine is a must-have for JavaScript programmers.

The other half is how to compose several or large quantity of individual state machines into a single one, concurrently of course. I won't talk it in near future, but we do have powerful patterns and extensive practices. When I am quite sure on the composition definitions and corresponding code patterns, I will talk it for discussion.







