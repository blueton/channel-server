var step = require('step');
var errors = require('./errors');
var normalize = require('./normalize');

/** Set by main.js */
var model;
exports.setModel = function(m) {
    model = m;
};

/** TODO: something configurable and/or meaningful, defaults for geo nodes */
function defaultConfig(req) {
    var owner = req.from;
    var a = owner.split(':');
    owner = a[a.length - 1].split('@')[0];

    return {
	title: owner + '\'s node',
	description: 'Where ' + owner + ' publishes things',
	type: 'http://www.w3.org/2005/Atom',
	accessModel: 'open',
	publishModel: 'subscribers',
	creationDate: new Date().toISOString()
    };
}

/**
 * Transactions with result data better callback with an Array, so we
 * can apply Result Set Management easily.
 */
var FEATURES = {
    'create-nodes': {
	create: {
	    requiredAffiliation: 'owner',
	    transaction: function(req, t, cb) {
		step(function() {
			 t.createNode(req.node, this);
		     }, function(err) {
			 if (err) throw err;

			 t.setConfig(req.node, defaultConfig(req), this);
		     }, function(err) {
			 if (err) throw err;

			 t.setAffiliation(req.node, req.from, 'owner', this);
		     }, function(err) {
			 if (err) throw err;

			 t.setSubscription(req.node, req.from, 'subscribed', this);
		     }, cb);
	    }
	}
    },
    subscribe: {
	subscribe: {
	    /* We don't use requiredAffiliation here because we are transitioning */
	    transaction: function(req, t, cb) {
		var config;
		step(function() {
		    t.getConfig(req.node, this);
		}, function(err, config_) {
		    if (err) throw err;

		    config = config_;
		    if (!config.accessModel ||
			config.accessModel === 'open')
			/* Shortcut, no need to get previous subscription */
			this(null, 'subscribed');
		    else
			t.getSubscription(req.node, req.from, this);
		}, function(err, subscription) {
		    if (err) throw err;

		    if (!subscription) {
			switch(config.accessModel) {
			    case 'authorize':
				this(null, 'pending');
				break;
			    default:
				throw new errors.Forbidden();
			}
		    } else
			this(null, subscription);
		}, function(err, subscription) {
		    if (err) throw err;

		    req.subscription = subscription;
		    t.setSubscription(req.node, req.from, subscription, this);
		}, function(err) {
		    if (err) throw err;

		    /* get owners only if subscription approval pending */
		    if (req.subscription === 'pending') {
			step(function() {
				 t.getOwners(req.node, this);
			     }, function(err, owners) {
				 if (err) throw err;

				 req.owners = owners;
				 this(null, req.subscription);
			     }, this);
		    } else
			this(null, req.subscription);
		}, cb);
	    },
	    afterTransaction: function(req) {
		if (req.subscription === 'pending' && req.owners)
		    req.owners.forEach(function(owner) {
			callFrontend('approve', owner, req.node, req.from);
		    });
	    }
	},
	unsubscribe: {
	    transaction: function(req, t, cb) {
		var nodeM = req.node.match(/^\/user\/(.+?)\/([a-zA-Z0-9\/\-]+)$/);
		var userM = req.from.match(/^(.+?):(.+)$/);
		if (nodeM && nodeM[1] === userM[2]) {
		    cb(new errors.NotAllowed('Owners must not abandon their channels'));
		    return;
		}

		t.setSubscription(req.node, req.from, 'none', cb);
	    }
	}
    },
    publish: {
	publish: {
	    requiredAffiliation: 'publisher',
	    transaction: function(req, t, cb) {
		var subscribers;

		step(function() {
			 if (objectIsEmpty(req.items))
			     this(null, []);
			 else {
			     var g = this.group();
			     for(var id in req.items) {
				 if (req.items.hasOwnProperty(id)) {
				     step(function() {
					 t.getItem(req.node, id, this);
				     }, function(err, oldItem) {
					 /* Ignore error; normalize may look for oldItem */
					 var reqItem = Object.create(req);
					 reqItem.item = req.items[id];
					 reqItem.itemId = id;
					 reqItem.oldItem = oldItem;
					 normalize.normalizeItem(reqItem, this);
				     }, function(err, reqNormalized) {
					 if (err) throw err;

					 t.writeItem(req.from, req.node, reqNormalized.itemId, reqNormalized.item, this);
				     }, g());
				 }
			     }
			 }
		     }, cb);
	    },
	    subscriberNotification: function(req, subscribers) {
		subscribers.forEach(function(subscriber) {
		    callFrontend('notify', subscriber.user, req.node, req.items);
		});
	    }
	}
    },
    'retract-items': {
	retract: {
	    requiredAffiliation: 'publisher',
	    transaction: function(req, t, cb) {
		var subscribers;

		/* TODO: check perms */
		step(function() {
			 if (req.itemIds.length < 1)
			     this(null, []);
			 else {
			     var g = this.group();
			     req.itemIds.forEach(function(itemId) {
				 t.deleteItem(req.node, itemId, g());
			     });
			 }
		     }, cb);
	    },
	    subscriberNotification: function(req, subscribers) {
		subscribers.forEach(function(subscriber) {
		    callFrontend('retracted', subscriber.user, req.node, req.itemIds);
		});
	    }
	}
    },
    'retrieve-items': {
	retrieve: {
	    requiredAffiliation: 'member',
	    transaction: function(req, t, cb) {
		var ids, items;
		step(function() {
			 t.getItemIds(req.node, this);
		     }, function(err, ids_) {
			 if (err) throw err;

			 /* Applying RSM now avoids fetching too many items.
			  * Later, this should become ie. SQL queries.
			  */
			 ids = applyRSM(req.rsmQuery, ids_);
			 if (ids.length < 1)
			     this(null, []);
			 else {
			     var g = this.group();
			     ids.forEach(function(id) {
				 t.getItem(req.node, id, g());
			     });
			 }
		     }, function(err, items) {
			 if (err) throw err;

			 var results = [];
			 var id, item;
			 while((id = ids.shift()) && (item = items.shift())) {
			     results.push({ id: id,
					    item: item });
			 }
			 /* RSM was applied to just ids, copy info: */
			 results.rsmResult = ids.rsmResult;
			 this(null, results);
		     }, cb);
	    }
	},
	/**
	 * For Message Archive Management
	 *
	 * Calls notifications before calling back with no result
	 */
	'replay': {
	    transaction: function(req, t, cb) {
		t.getUpdatesByTime(req.from, req.timeStart, req.timeEnd, req.notifyCb, cb);
	    }
	}
    },
    'retrieve-subscriptions': {
	retrieve: {
	    transaction: function(req, t, cb) {
		t.getSubscriptions(req.from, cb);
	    }
	}
    },
    'retrieve-affiliations': {
	retrieve: {
	    transaction: function(req, t, cb) {
		t.getAffiliations(req.from, cb);
	    }
	}
    },
    'manage-subscriptions': {
	retrieve: {
	    requiredAffiliation: 'member',
	    transaction: function(req, t, cb) {
		t.getSubscribers(req.node, cb);
	    }
	},
	modify: {
	    requiredAffiliation: 'owner',
	    /* TODO: only let owner subscribe users who intended to */
	    transaction: function(req, t, cb) {
		step(function() {
			 if (objectIsEmpty(req.subscriptions)) {
			     this(null);
			     return;
			 }

			 var g = this.group();
			 for(var user in req.subscriptions) {
			     var subscription = req.subscriptions[user];
			     switch(subscription) {
			     case 'subscribed':
				     t.setSubscription(req.node, user, g());
				     break;
			     case 'none':
				     t.setSubscription(req.node, user, g());
				     break;
			     default:
				 throw new errors.BadRequest(subscription + ' is no subscription type');
			     }
			 }
		     }, cb);
	    },
	    afterTransaction: function(req) {
		for(var user in req.subscriptions) {
		    callFrontend('subscriptionModified', user, req.subscriptions[user]);
		}
	    }
	}
    },
    'modify-affiliations': {
	retrieve: {
	    requiredAffiliation: 'member',
	    /* TODO: outcast only if req.affiliation == 'owner' or 'publisher' */
	    transaction: function(req, t, cb) {
		t.getAffiliated(req.node, cb);
	    }
	},
	modify: {
	    requiredAffiliation: 'owner',
	    transaction: function(req, t, cb) {
		if (objectIsEmpty(req.affiliations)) {
		    this(null);
		    return;
		}

		step(function() {
			 var g = this.group();
			 for(var user in req.affiliations) {
			     var affiliation = req.affiliations[user];
			     /* TODO: validate affiliation */
			     t.setAffiliation(req.node, user, affiliation, g());
			 }
		     }, cb);
	    }
	}
    },
    'config-node': {
	retrieve: {
	    requiredAffiliation: 'member',
	    transaction: function(req, t, cb) {
		step(function() {
		    t.getConfig(req.node, this);
		}, function(err, config) {
		    if (!config)
			config = defaultConfig(req);

		    this(null, config);
		}, cb);
	    }
	},
	modify: {
	    requiredAffiliation: 'owner',
	    /**
	     * Get default config first, so clients don't have send
	     * back all fields.
	     */
	    transaction: function(req, t, cb) {
		step(function() {
		    t.getConfig(req.node, this);
		}, function(err, config) {
		    if (!config)
			config = defaultConfig(req);
		    /* keep for subscriberNotification */
		    req.config = config;

		    t.setConfig(req.node,
				{ title: req.title || config.title,
				  description: req.description || config.description,
				  type: req.type || config.type,
				  accessModel: req.accessModel || config.accessModel,
				  publishModel: req.publishModel || config.publishModel,
				  creationDate: config.creationDate
				}, this);
		}, cb);
	    },
	    subscriberNotification: function(req, subscribers) {
		subscribers.forEach(function(subscriber) {
		    callFrontend('configured', subscriber.user, req.node, req.config);
		});
	    }
	}
    },
    'get-pending': {
	'list-nodes': {
	    transaction: function(req, t, cb) {
		t.getPendingNodes(req.from, cb);
	    }
	},
	'get-for-node': {
	    requiredAffiliation: 'owner',
	    transaction: function(req, t, cb) {
		step(function() {
		    t.getPending(req.node, this);
		}, function(err, users) {
		    if (err) throw err;

		    req.pendingUsers = users;
		    this(null);
		}, cb);
	    },
	    afterTransaction: function(req) {
		req.pendingUsers.forEach(function(user) {
		    callFrontend('approve', req.from, req.node, user);
		});
	    }
	}
    },
    /* Actually no pubsub feature but fits here snugly */
    register: {
	register: {
	    transaction: function(req, t, cb) {
		var m, user = req.from;
		if ((m = user.match(/^.+:(.+)$/)))
		    user = m[1]; /* strip proto prefix */

		/* TODO: make configurable */
		var nodes = ['channel', 'mood', 'subscriptions',
			     'geo/current', 'geo/future',
			     'geo/previous'].map(function(name) {
		    return '/user/' + user + '/' + name;
		});

		step(function() {
		    var g = this.group();
		    nodes.forEach(function(node) {
			t.createNode(node, g());
		    });
		}, function(err) {
		    if (err) throw err;

		    var g = this.group();
		    nodes.forEach(function(node) {
			t.setConfig(node, defaultConfig(req), g());
			t.setAffiliation(node, req.from, 'owner', g());
			t.setSubscription(node, req.from, 'subscribed', g());
		    });
		}, cb);
	    }
	}
    },
    /* Actually no pubsub feature but fits here snugly */
    'browse-nodes': {
	list: {
	    transaction: function(req, t, cb) {
		/* TODO: add stats like num_subscribers */
		t.listNodes(cb);
	    }
	},
	'by-user': {
	    transaction: function(req, t, cb) {
		/* TODO: add stats like num_subscribers */
		var m;
		if ((m = req.node.match(/^\/user\/([^\/]+)$/)))
		    t.listNodesByUser(m[1], cb);
		else
		    throw new errors.NotFound('User not found');
	    }
	}
    }
};

exports.pubsubFeatures = function() {
    var result = [];
    for(var f in FEATURES)
	result.push(f);
    return result;
};

exports.request = function(req) {
    var feature = FEATURES[req.feature];
    var operation = feature && feature[req.operation];
    req.affiliation = 'none';

    if (!operation) {
	req.callback(new errors.FeatureNotImplemented('Operation not yet supported'));
	return;
    }
    var debug = function(s) {
	console.log(req.from + ' >> ' + req.feature + '/' + req.operation + ': ' + s);
    };

    /* TODO: no underscores */
    if (req.node && req.from) {
	var nodeM = req.node.match(/^\/user\/(.+?)\/([a-zA-Z0-9\/\-]+)$/);
	var userM = req.from.match(/^(.+?):(.+)$/);
	if (nodeM && nodeM[1] === userM[2])
	    req.affiliation = 'owner';
    }

    model.transaction(function(err, t) {
	if (err) {
	    req.callback(err);
	    return;
	}

	var steps = [function(err) {
			 /* Unfortunately, step starts with err = [] */
			 this(null);
		     }];

	/* Retrieve affiliation if needed */
	if (operation.requiredAffiliation &&
	    !isAffiliationSubset(operation.requiredAffiliation, req.affiliation)) {

	    var config;
	    steps.push(function(err) {
		if (err) throw err;

		t.getConfig(req.node, this);
	    }, function(err, config_) {
		if (err) throw err;

		config = config_;

		t.getAffiliation(req.node, req.from, this);
	    }, function(err, affiliation) {
		if (err) throw err;

		req.affiliation = affiliation || req.affiliation;

		t.getSubscription(req.node, req.from, this);
	    }, function(err, subscription) {
		if (err) throw err;

		if (req.affiliation === 'none' &&
		    (!config.accessModel || config.accessModel === 'open')) {
		    /* 'open' model: members don't need to be approved */
		    req.affiliation = 'member';
		} else if (req.affiliation === 'member' &&
			   config.publishModel === 'publishers' &&
			   subscription === 'subscribed') {
		    /* set affiliation = 'publisher' only if user subscribed */
		    req.affiliation = 'publisher';
		}

		if (isAffiliationSubset(operation.requiredAffiliation, req.affiliation))
		    this();
		else
		    this(new errors.Forbidden(operation.requiredAffiliation + ' required'));
	    });
	}

	/* Run operation transaction first */
	var transactionResults;
	steps.push(function(err) {
	    if (err) throw err;
	    debug('transaction');

	    operation.transaction(req, t, this);
	}, function(err) {
	    if (err) throw err;
	    debug('transaction done');

	    /* Regardless of the following steps, we pass
	     * the operation's transaction result to the
	     * final callback.
	     */
	    transactionResults = arguments;
	    /* And continue:
	     */
	    this(null);
	});
        var subscribers;
	if (operation.subscriberNotification) {
	    /* For subscriber notification, get the list of subscribers
	     * while still inside transaction.
	     */
	    steps.push(function(err) {
		if (err) throw err;

		t.getSubscribers(req.node, this);
	    }, function(err, subscribers_) {
		if (err) throw err;

		subscribers = subscribers_;
		this(null);
	    });
	}
	/* Finalize transaction
	 */
	steps.push(function(err) {
	    if (err) {
		var that = this;
		debug('transaction rollback: ' + (err.message || JSON.stringify(err)));
		t.rollback(function() {
		    /* Keep error despite successful rollback */
		    that(err);
		});
	    } else {
		debug('transaction commit');
		t.commit(this);
	    }
	});
	if (operation.afterTransaction) {
	    steps.push(function(err) {
		if (err) throw err;

		operation.afterTransaction(req);
		this(null);
	    });
	}
	if (operation.subscriberNotification) {
	    /* Transaction successful? Call subscriberNotification. */
	    steps.push(function(err) {
		if (err) throw err;

		operation.subscriberNotification(req, subscribers);
		this(null);
	    });
	}
	/* Last step: return to caller (view) */
	steps.push(function(err) {
	    debug('callback');
	    if (err && req.callback) {
		if (!err.stack) {
		    /* Simulate a stack for developer/administrator
		     * information in case the error wasn't thrown but
		     * emitted manually.
		     */
		    err.stack = (err.message || err.condition || 'Error') +
			' @ ' + req.feature + '/' + req.operation;
		}

		req.callback(err);
	    } else if (req.callback) {
		req.callback.apply(req, transactionResults);
	    }
	});

	/* Finally, run all the steps we assembled above */
	step.apply(null, steps);
    });
};

/*
 * This is not a request, but used internally to send out presence
 * probes at startup.
 */
exports.getAllSubscribers = function(cb) {
    model.transaction(function(err, t) {
	if (err) {
	    cb(err);
	    return;
	}

	t.getAllSubscribers(function(err, subscribers) {
	    if (err) {
		t.rollback(function() {
			       cb(err);
			   });
		return;
	    }

	    t.commit(function() {
		cb(null, subscribers);
	    });
	});
    });

};

/**
 * Applies Result Set Management
 * 
 * @param results {Array}
 * @return {Array} Annotated with rsmResult key
 */
/* TODO: default max length */
function applyRSM(rsmQuery, results) {
    /* We always return RSM even if queried w/o */
    rsmQuery = rsmQuery || {};
    /* rsmResult with total length */
    var rsmResult = { count: results.length };

    if (rsmQuery.after) {
	while(results.length > 0) {
	    var key = results.shift();
	    if (key === rsmQuery.after)
		break;
	}
    }
    if (rsmQuery.before) {
	while(results.length > 0) {
	    var key = results.pop();
	    if (key === rsmQuery.before)
		break;
	}
	/* If queried before a certain id, the front is snapped off: */
	if (rsmQuery.count) {
	    results = results.slice(Math.max(0, results.length - rsmQuery.count));
	}
    }
    if (rsmQuery.count) {
	results = results.slice(0, rsmQuery.count);
    }

    /* rsmResult indicating first & last id of this selection */
    if (results.length > 0) {
	rsmResult.first = results[0];
	rsmResult.last = results[results.length - 1];
    }
    return Object.create({ rsmResult: rsmResult }, { o: results });
}

/**
 * Affiliations comparison
 */

var AFFILIATION_SUBSETS = {
    owner: ['moderator', 'publisher', 'member', 'none'],
    moderator: ['publisher', 'member', 'none'],
    publisher: ['member', 'none'],
    member: ['none']
};
function isAffiliationSubset(subset, affiliation) {
    return subset === affiliation ||
	   (AFFILIATION_SUBSETS.hasOwnProperty(affiliation) &&
	    AFFILIATION_SUBSETS[affiliation].indexOf(subset) >= 0);
}


/**
 * Frontend hooking
 */

var frontends = {};

/**
 * Hook frontend for uri prefix
 */
exports.hookFrontend = function(proto, hooks) {
    frontends[proto] = hooks;
};

/**
 * Call named hook by uri prefix
 */
function callFrontend(hook, uri) {
    var colonPos = uri.indexOf(':');
    if (colonPos > 0) {
	var proto = uri.substr(0, colonPos);
	uri = uri.substr(colonPos + 1);
    } else
	return;

    var args = Array.prototype.slice.call(arguments, 1);
    var frontend = frontends.hasOwnProperty(proto) && frontends[proto];
    var hookFun = frontend && frontend.hasOwnProperty(hook) && frontend[hook];
console.log({callFrontend:arguments,frontent:frontend,hookFun:hookFun,args:args});

    if (hookFun) {
	return hookFun.apply(frontend, args);
    }
};


/* A helper */

function objectIsEmpty(o) {
    for(var k in o) {
	if (o.hasOwnProperty(k))
	    return false;
    }
    return true;
}
