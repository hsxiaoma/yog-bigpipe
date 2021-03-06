var Pagelet = require('./pagelet.js');
var status = Pagelet.status;
var mode = Pagelet.mode;
var _ = require('./util.js');
var Readable = require('stream').Readable;
var util = require('util');
var Promise = require('bluebird');

var BigPipe = module.exports = function BigPipe(options) {
    this.options = _.mixin(_.mixin({}, BigPipe.options), options);
    this.map = {};
    this.pagelets = [];
    this.pipelines = [];
    this.rendered = [];
    this.sources = {};
    this.state = status.pending;
    this.quicklings = [];
    this.parentQuicklings = [];
    this.Pagelet = Pagelet;
    this.pageletData = {};

    this.on('pagelet:after', this._onPageletDone);
    Readable.call(this, null);
};

// default options
BigPipe.options = {
    skipAnalysis: true,
    // configure output template.
    // you can use the following varible.
    // 
    // - this.id            pagelet id
    // - this.js            pagelet js
    // - this.css           pagelet css
    // - this.scripts       pagelet inline scripts
    // - this.styles        pagelet inline css
    // - this.html          pagelet html content
    // - this.container     pagelet container if specified
    // - this.json          stringfied json data.
    tpl: {
        _default: '<script type="text/javascript">' +
            'BigPipe.onPageletArrive(<%= this.json %>);' +
            '</script>',

        quickling: 'BigPipe.onPageletArrive(<%= this.json %>);'
    }
};

util.inherits(BigPipe, Readable);

// don't call this directly.
BigPipe.prototype._read = function (n) {
    if (this.state === status.pending) {
        this.render();
    }
};

// bind pagelet data source.
// accept fucntion and model name.
BigPipe.prototype.bind = function (id, fn) {
    if (fn.length >= 1 && id !== 'all') {
        fn = Promise.promisify(fn);
    }
    else if (fn.length >= 2 && id === 'all') {
        fn = Promise.promisify(fn);
    }
    this.sources[id] = fn;
    return this;
};

// 当为 quickling 模式的时候调用。
// 设置后，只有在此列表中的 pagelet 才会渲染。
BigPipe.prototype.addQuicklingPagelets = function (pagelets) {
    var me = this;
    pagelets.forEach(function (id) {
        var pageletIDSplit = id.split('@');
        var pageletID = pageletIDSplit.shift();
        me.quicklings.push(pageletID);
        me.parentQuicklings.push.apply(me.parentQuicklings, pageletIDSplit);
    });
};

// 判断是否是 quickling 模式。
BigPipe.prototype.isQuicklingMode = function () {
    return !!(this.quicklings && this.quicklings.length);
};

// 拼写兼容
BigPipe.prototype.isQuickingMode = BigPipe.prototype.isQuicklingMode;

// 添加 pagelet.
BigPipe.prototype.addPagelet = function (obj) {
    // 已经晚了了，不处理。
    if (this.state === status.fulfilled) {
        return false;
    }
    else if (!obj.id) {
        this.emit('error', new Error('Id is required when add pagelet'));
        return;
    }
    else if (obj.id === 'all') {
        this.emit('error', new Error('all is a preserved word for pagelet'));
        return;
    }

    if (!this.isQuicklingMode() && obj.mode !== mode.pipeline && obj.mode !== mode.async) {
        // 非 quickling 请求，只接收 pipeline 和 async 模式的 pagelet.
        return false;
    }
    else if (this.isQuicklingMode() && !~this.quicklings.indexOf(obj.id)) {
        // 以下几种情况均需要继续执行
        // 1. 被声明为父Pagelet
        // 2. 先祖Pagelet被请求了

        if (!~this.parentQuicklings.indexOf(obj.id)) {
            var parent, founded;
            // 如果没有被声明为父Pagelet，则检查是否属于先祖Pagelet被请求了的情况

            // 如果是lazy模式，则不寻找先祖Pagelet
            if (obj.lazy) {
                return false;
            }
            // 支持嵌套pagelet时，一次性返回所有pagelet
            parent = obj;
            founded = false;
            // 如果指定的pagelet不在quicklings列表中，检查先祖节点，查看先祖节点是否在列表中，如果在则加载
            // 以此实现Pagelet A contain Pagelet B时，会用一个请求同时返回A与B
            while (parent && parent.parentId) {
                parent = this.map[parent.parentId];
                if (this.isQuicklingWidget(parent) && !!~this.quicklings.indexOf(parent.id)) {
                    founded = true;
                    // 插入为需要输出的Pagelet
                    this.quicklings.push(obj.id);
                    break;
                }
            }
            if (!founded) {
                return false;
            }
        }
    }

    obj.reqID = this.reqID;
    obj.skipAnalysis = this.options.skipAnalysis;

    var pagelet = new Pagelet(obj);
    var self = this;

    this.pagelets.push(pagelet);
    this.map[pagelet.id] = pagelet;
    pagelet.mode === mode.pipeline && this.pipelines.push(pagelet);

    // 转发事件。
    pagelet.on('error', this.emit.bind(this, 'error'));
    [
        'before', 'after',
        'render:before', 'render:after',
        'analyse:before', 'analyse:after'
    ].forEach(function (name) {
        pagelet.on(name, self.emit.bind(self, 'pagelet:' + name, pagelet));
    });

    if (this.state === status.rendering) {
        this.renderPagelet(pagelet);
    }
};

BigPipe.prototype.isQuicklingWidget = function (item) {
    return (item.mode === mode.quickling || item.mode === mode.async || item.mode === mode.pipeline);
};

BigPipe.prototype.render = function () {
    if (!this.pagelets) {
        return;
    }
    var pagelets = this.pagelets.concat();

    this.state = status.rendering;

    pagelets.forEach(this.renderPagelet.bind(this));
    this._checkFinish();
};

BigPipe.prototype.prepareAllSources = function () {
    var sources = this.sources;
    var promiseSources = {};
    var me = this;

    // this.emit('pagelet:source', '*', function (_source) {
    //     if (_source.length >= 2) {
    //         _source = Promise.promisify(_source);
    //     }
    //     sources.all = _source;
    // });
    // when using res.bigpipe.bind('all'), pass * to cb to get all data
    if (sources.all) {
        return sources.all('*').then(function (data) {
            me.pageletData = data;
            return data;
        });
    }
    for (var id in sources) {
        if (sources.hasOwnProperty(id)) {
            // 屏蔽所有异常
            promiseSources[id] = sources[id]().catch(function (err) {
                return {
                    BigPipeFailed: true,
                    err: err
                };
            });
        }
    }
    return Promise.props(promiseSources).then(function (data) {
        me.pageletData = data;
        return data;
    });
};

BigPipe.prototype.renderPagelet = function (pagelet) {
    var sources = this.sources;
    var source = sources[pagelet.id];

    // 屏蔽无法调整为同步的 bigpipe 绑定策略
    if (!source && typeof sources.all === 'function') {
        source = sources.all.bind(null, pagelet.id);
    }

    // hook
    // this.emit('pagelet:source', pagelet.id, function (_source) {
    //     if (_source.length >= 2) {
    //         _source = Promise.promisify(_source);
    //     }
    //     source = _source;
    // });

    if (this.pageletData[pagelet.id]) {
        pagelet.start(this.pageletData[pagelet.id], true);
    }
    else {
        pagelet.start(source);
    }
};

BigPipe.prototype.destroy = function () {
    this.sources = null;

    this.removeAllListeners();

    this.rendered.concat(this.pagelets).forEach(function (pagelet) {
        pagelet.destroy();
    });

    this.rendered = this.pipelines = this.pagelets = this.map = this.quicklings = null;
};

BigPipe.prototype._onPageletDone = function (pagelet) {
    var cb, idx, item;

    if (pagelet.mode === mode.pipeline) {
        // 必须按顺序
        // idx = this.pipelines.indexOf(pagelet);

        // // if this is not the first pipline pagelet.
        // if (idx !== 0) {
        //     return;
        // }

        // 必须是第一个才开始吐数据。否则等待。
        while ((item = this.pipelines[0]) &&
            item.state === status.fulfilled) {

            this.outputPagelet(item);
        }
    }
    else {
        this.outputPagelet(pagelet);
    }

    process.nextTick(this._checkFinish.bind(this));
};

BigPipe.prototype._checkFinish = function () {
    if (!this.pagelets.length && this.state === status.rendering) {
        // 标记已经完成。
        this.state = status.fulfilled;
        this.push(null);
    }
};

BigPipe.prototype.outputPagelet = function (pagelet) {
    var content = this.format(pagelet);
    if (!this.isQuicklingMode() || !!~this.quicklings.indexOf(pagelet.id)) {
        content && this.push(content);
    }
    this._markPageletRendered(pagelet);
};

BigPipe.prototype.format = function (pagelet) {
    var tpl = this.options.tpl;
    var type = this.isQuicklingMode() ? 'quickling' : '_default';
    var json = pagelet.toJson();
    var obj = {};

    tpl = tpl[type] || tpl['_default'];

    _.mixin(obj, json);
    obj.json = JSON.stringify(json);

    return _.tpl(tpl, obj);
};

BigPipe.prototype._markPageletRendered = function (pagelet) {
    var idx = this.pagelets.indexOf(pagelet);
    var removed = this.pagelets.splice(idx, 1)[0];

    idx = this.pipelines.indexOf(pagelet);
    ~idx && this.pipelines.splice(idx, 1);

    // should I save this?
    this.rendered.push(removed);
};
