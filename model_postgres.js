var pg = require('pg');
var step = require('step');
var ltx = require('ltx');
var errors = require('./errors');

/* ready DB connections */
var pool = [];
/* waiting transaction requests */
var queue = [];

/* at start and when connection died */
function connectDB(config) {
    var db = new pg.Client(config);
    db.connect();

    /* Reconnect in up to 5s */
    db.on('error', function(err) {
	console.error('Postgres: ' + err.message);
	setTimeout(function() {
	    connectDB(config);
	}, Math.ceil(Math.random() * 5000));
	try { db.end(); } catch (e) { /* Alright */ }
    });

    /* wait until connected & authed */
    db.connection.once('readyForQuery', function() {
	dbIsAvailable(db);
    });
}

function dbIsAvailable(db) {
    var cb;
    if ((cb = queue.shift())) {
	/* request was waiting in queue */
	cb(db);
    } else {
	/* no request, put into pool */
	pool.push(db);
    }
}

/* config: { user, database, host, port, poolSize: 4 } */
exports.start = function(config) {
    for(var i = 0; i < (config.poolSize || 4); i++) {
	connectDB(config);
    }
};


exports.transaction = function(cb) {
    var db;
    if ((db = pool.shift())) {
	/* Got one from pool */
	new Transaction(db, cb);
    } else {
	/* Pool was empty, waiting... TODO: limit length, shift first */
	queue.push(function(db) {
	    new Transaction(db, cb);
	});
    }
};

/**
 * Wraps the postgres-js transaction with our model operations.
 */
function Transaction(db, cb) {
    var that = this;
    this.db = db;

    db.query("BEGIN", [], function(err, res) {
	cb(err, that);
    });
}

Transaction.prototype.commit = function(cb) {
    var db = this.db;
    db.query("COMMIT", [], function(err, res) {
	process.nextTick(function() {
	    dbIsAvailable(db);
	});

	cb(err);
    });
};

Transaction.prototype.rollback = function(cb) {
    var db = this.db;

    db.query("ROLLBACK", [], function(err, res) {
	process.nextTick(function() {
	    dbIsAvailable(db);
	});

	cb(err);
    });
};


/**
 * Actual data model
 */

/**
 * Can be dropped in a step() sequence to validate presence of a node.
 */
Transaction.prototype.nodeExists = function(node) {
    var db = this.db;

    return function() {
	step(function() {
	    db.query("SELECT node FROM nodes WHERE node=$1",
		     [node], this);
	}, function(err, res) {
	    if (err) throw err;

	    if (res.rowCount < 1)
		throw new errors.NotFound('Node does not exist');

	    this();
	}, this);
    };
};

Transaction.prototype.createNode = function(node, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT node FROM nodes WHERE node=$1",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	if (res.rowCount > 0)
	    throw new errors.Conflict('Node already exists');

	db.query("INSERT INTO nodes (node) VALUES ($1)", [node], this);
    }, cb);
};

/**
 * cb(err, [{ node: String, title: String }])
 */
Transaction.prototype.listNodes = function(cb) {
    var db = this.db;

    step(function() {
	/* TODO: order by COUNT(subscribers) */
	db.query("SELECT node FROM nodes WHERE node IN (SELECT node FROM node_config WHERE \"key\"=\'accessModel\' AND \"value\"=\'open\') " +
		 "ORDER BY node ASC", this);
    }, function(err, res) {
	if (err) throw err;

	var nodes = res.rows.map(function(row) {
	    return { node: row.node,
		     title: row.title
		   };
	});
	this(null, nodes);
    }, cb);
};

Transaction.prototype.listNodesByUser = function(user, cb) {
    var db = this.db;

    step(function() {
	/* TODO: order by COUNT(subscribers) */
	db.query("SELECT node FROM nodes WHERE position('/user/' || $1 IN node) = 1 AND node IN (SELECT node FROM node_config WHERE \"key\"=\'accessModel\' AND \"value\"=\'open\') " +
		 "ORDER BY node ASC", [user], this);
    }, function(err, res) {
	if (err) throw err;

	var nodes = res.rows.map(function(row) {
	    return { node: row.node,
		     title: row.title
		   };
	});
	this(null, nodes);
    }, cb);
};

/**
 * Subscription management
 */

Transaction.prototype.getSubscription = function(node, user, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT subscription FROM subscriptions WHERE node=$1 AND user=$2",
		 [node, user], this);
    }, function(err, res) {
	if (err) throw err;

	this(null, (res.rows[0] && res.rows[0].subscription) || 'none');
    }, cb);
};

Transaction.prototype.setSubscription = function(node, user, subscription, cb) {
    var db = this.db;

    step(this.nodeExists(node),
    function(err) {
	if (err) throw err;

	db.query("SELECT subscription FROM subscriptions WHERE node=$1 AND user=$2",
		 [node, user], this);
    }, function(err, res) {
	if (err) throw err;

	var isSet = res && res.rows && res.rows[0];
	var toDelete = !subscription || subscription == 'none';
	if (isSet && !toDelete)
	    db.query("UPDATE subscriptions SET subscription=$1 WHERE node=$2 AND \"user\"=$3",
		     [subscription, node, user], this);
	else if (!isSet && !toDelete)
	    db.query("INSERT INTO subscriptions (node, \"user\", subscription) VALUES ($1, $2, $3)",
		     [node, user, subscription], this);
	else if (isSet && toDelete)
	    db.query("DELETE FROM subscriptions WHERE node=$1 AND \"user\"=$2",
		     [node, user], this);
	else if (!isSet && toDelete)
	    cb(null);  /* do nothing */
    }, cb);
};

Transaction.prototype.getSubscribers = function(node, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT \"user\", subscription FROM subscriptions WHERE node=$1",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	var subscribers = [];
	res.rows.forEach(function(row) {
	    subscribers.push({ user: row.user,
			       subscription: row.subscription });
	});
	this(null, subscribers);
    }, cb);
};

Transaction.prototype.getSubscriptions = function(user, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT node, subscription FROM subscriptions WHERE \"user\"=$1",
		 [user], this);
    }, function(err, res) {
	if (err) throw err;

	var subscriptions = [];
	res.rows.forEach(function(row) {
	    subscriptions.push({ node: row.node,
				 subscription: row.subscription });
	});
	this(null, subscriptions);
    }, cb);
};

Transaction.prototype.getAllSubscribers = function(cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT DISTINCT \"user\" FROM subscriptions",
		 this);
    }, function(err, res) {
	if (err) throw err;

	var subscribers = [];
	res.rows.forEach(function(row) {
	    subscribers.push(row.user);
	});
	this(null, subscribers);
    }, cb);
};

Transaction.prototype.getPendingNodes = function(user, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT node FROM affiliations WHERE affiliation = 'owner' AND user = $1 AND EXISTS (SELECT user FROM subscriptions WHERE subscription = 'pending' AND node = affiliations.node)",
		 [user], this);
    }, function(err, res) {
	if (err) throw err;

	this(null, res.rows.map(function(row) {
	    return row.node;
	}));
    }, cb);
};

Transaction.prototype.getPending = function(node, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT user FROM subscriptions WHERE subscription = 'pending' AND node = $1",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	this(null, res.rows.map(function(row) {
	    return row.user;
	}));
    }, cb);
};

/**
 * Affiliation management
 */

Transaction.prototype.getAffiliation = function(node, user, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT affiliation FROM affiliations WHERE node=$1 AND user=$2",
		 [node, user], this);
    }, function(err, res) {
	if (err) throw err;

	this(null, (res.rows[0] && res.rows[0].affiliation) || 'none');
    }, cb);
};

Transaction.prototype.setAffiliation = function(node, user, affiliation, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT affiliation FROM affiliations WHERE node=$1 AND user=$2",
		 [node, user], this);
    }, function(err, res) {
	if (err) throw err;

	var isSet = res && res.rows && res.rows[0];
	var toDelete = !affiliation || affiliation == 'none';
	if (isSet && !toDelete)
	    db.query("UPDATE affiliations SET affiliation=$1 WHERE node=$2 AND \"user\"=$3",
		     [affiliation, node, user], this);
	else if (!isSet && !toDelete)
	    db.query("INSERT INTO affiliations (node, \"user\", affiliation) VALUES ($1, $2, $3)",
		     [node, user, affiliation], this);
	else if (isSet && toDelete)
	    db.query("DELETE FROM affiliations WHERE node=$1 AND \"user\"=$2",
		     [node, user], this);
	else if (!isSet && toDelete)
	    cb(null);  /* do nothing */
    }, cb);
};

Transaction.prototype.getAffiliations = function(user, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT node, affiliation FROM affiliations WHERE \"user\"=$1",
		 [user], this);
    }, function(err, res) {
	if (err) throw err;

	var affiliations = [];
	res.rows.forEach(function(row) {
	    affiliations.push({ node: row.node,
				affiliation: row.affiliation });
	});
	this(null, affiliations);
    }, cb);
};

Transaction.prototype.getAffiliated = function(node, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT \"user\", affiliation FROM affiliations WHERE node=$1",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	var affiliations = [];
	res.rows.forEach(function(row) {
	    affiliations.push({ user: row.user,
				affiliation: row.affiliation });
	});
	this(null, affiliations);
    }, cb);
};

Transaction.prototype.getOwners = function(node, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT \"user\" FROM affiliations WHERE node=$1 AND affiliation='owner'",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	this(null, res.rows.map(function(row) {
	    return row.user;
	}));
    }, cb);
};

Transaction.prototype.writeItem = function(publisher, node, id, item, cb) {
    var db = this.db;
    var xml = item.toString();

    step(this.nodeExists(node),
    function(err) {
	if (err) throw err;

	db.query("SELECT id FROM items WHERE node=$1 AND id=$2",
		 [node, id], this);
    }, function(err, res) {
	if (err) throw err;

	var isSet = res && res.rows && res.rows[0];
	if (isSet)
	    db.query("UPDATE items SET xml=$1, published=CURRENT_TIMESTAMP WHERE node=$2 AND id=$3",
		     [xml, node, id], this);
	else if (!isSet)
	    db.query("INSERT INTO items (node, id, xml, published) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
		     [node, id, xml], this);
    }, cb);
};

Transaction.prototype.deleteItem = function(node, itemId, cb) {
    var db = this.db;

    step(function() {
	db.query("DELETE FROM items WHERE node=$1 AND id=$2",
		 [node, itemId], this);
    }, function(err, res) {
	if (err) throw err;

	if (res.rowCount < 1)
	    throw new errors.NotFound('No such item');

	this(null);
    }, cb);
};

/**
 * sorted by time
 */
Transaction.prototype.getItemIds = function(node, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT id FROM items WHERE node=$1 ORDER BY published DESC",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	var ids = res.rows.map(function(row) {
	    return row.id;
	});
	this(null, ids);
    }, cb);
};

function parseItem(xml) {
    try {
	return ltx.parse(xml);
    } catch (e) {
	console.error('Parsing ' + xml + ': ' + e.stack);
	return undefined;
    }
}

Transaction.prototype.getItem = function(node, id, cb) {
    var db = this.db;

    step(function() {
	db.query("SELECT xml FROM items WHERE node=$1 AND id=$2",
		 [node, id], this);
    }, function(err, res) {
	if (err) throw err;

	if (res && res.rows && res.rows[0]) {
	    var item = parseItem(res.rows[0].xml);
	    this(null, item);
	} else {
	    throw new errors.NotFound('No such item');
	}
    }, cb);
};

/**
 * @param itemCb {Function} itemCb({ node: String, id: String, item: Element })
 */
Transaction.prototype.getUpdatesByTime = function(subscriber, timeStart, timeEnd, itemCb, cb) {
    var conditions = ['node IN (SELECT node FROM subscriptions WHERE "user"=$1 AND subscription=\'subscribed\')'],
	params = [subscriber], i = 1;
    if (timeStart) {
	conditions.push('published >= $' + (++i) + '::timestamp');
	params.push(timeStart);
    }
    if (timeEnd) {
	conditions.push('published <= $' + (++i) + '::timestamp');
	params.push(timeEnd);
    }
    var q = this.db.query("SELECT id, node, xml FROM items WHERE " +
			  conditions.join(' AND ') +
			  " ORDER BY published ASC",
			  params);
    q.on('row', function(row) {
	var item = parseItem(row.xml);
	if (item)
	    itemCb({ node: row.node,
		     id: row.id,
		     item: item
		   });
    });
    var err;
    q.on('error', function(err_) {
	err = err_;
    });
    q.on('end', function() {
	cb(err);
    });
};

/**
 * Config management
 */

Transaction.prototype.getConfig = function(node, cb) {
    var db = this.db;

    step(this.nodeExists(node),
    function(err) {
	if (err) throw err;

	db.query("SELECT \"key\", \"value\" FROM node_config WHERE node=$1",
		 [node], this);
    }, function(err, res) {
	if (err) throw err;

	if (res.rows) {
	    var config = {};
	    res.rows.forEach(function(row) {
		config[row.key] = row.value;
	    });
	    this(null, config);
	} else
	    throw new errors.NotFound('No such node');
    }, cb);
};

Transaction.prototype.setConfig = function(node, config, cb) {
    var db = this.db;

console.log('setConfig ' + node + ': ' + require('util').inspect(config));
    step(this.nodeExists(node),
    function(err) {
	if (err) throw err;

	/* If user supplied only partial information, old/default
	 * values will be added by controller. That way we can just
	 * INSERT later. */
	 db.query("DELETE FROM node_config WHERE node=$1", [node], this);
    }, function(err) {
	if (err) throw err;

	var g = this.parallel();
	for(var key in config)
	    if (config.hasOwnProperty(key)) {
		var value = config[key];
		/* Do not set configuration fields that have:
		 * * not been specified
		 * * no default config
		 */
		if (value === '' || value)
		    db.query("INSERT INTO node_config (key, value, node) " +
			     "VALUES ($1, $2, $3)",
			     [key, value, node], g);
	    }
	g();
    }, function(err, res) {
	if (err) throw err;

	this(null);
    }, cb);
};
