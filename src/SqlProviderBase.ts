/**
 * SqlProviderBase.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Abstract helpers for all NoSqlProvider DbProviders that are based on SQL backings.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import FullTextSearchHelpers = require('./FullTextSearchHelpers');
import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

const schemaVersionKey = 'schemaVersion';

interface IndexMetadata {
    key: string;
    storeName: string;
    index: NoSqlProvider.IndexSchema;
}

function getIndexIdentifier(storeSchema: NoSqlProvider.StoreSchema, index: NoSqlProvider.IndexSchema): string {
    return storeSchema.name + '_' + index.name;
}

const FakeFTSJoinToken = '^$^';

export abstract class SqlProviderBase extends NoSqlProvider.DbProvider {
    constructor(protected _supportsFTS3: boolean) {
        super();
        // NOP
    }

    private _getMetadata(trans: SqlTransaction): SyncTasks.Promise<{ name: string; value: string; }[]> {
        // Create table if needed
        return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(() => {
            return trans.runQuery('SELECT name, value from metadata', []);
        });
    }

    private _storeIndexMetadata(trans: SqlTransaction, meta: IndexMetadata) {
        return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES' +
            '(\'' + meta.key + '\', ?)', [JSON.stringify(meta)]);
    }

    private _getDbVersion(): SyncTasks.Promise<number> {
        return this.openTransaction(undefined, true).then((trans: SqlTransaction) => {
              // Create table if needed
            return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(() => {
                return trans.runQuery('SELECT value from metadata where name=?', [schemaVersionKey]).then(data => {
                    if (data && data[0] && data[0].value) {
                        return Number(data[0].value) || 0;
                    }
                    return 0;
                });
            });
        });
    }

    protected _changeDbVersion(oldVersion: number, newVersion: number): SyncTasks.Promise<SqlTransaction> {
        return this.openTransaction(undefined, true).then((trans: SqlTransaction) => {
            return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES (\'' + schemaVersionKey + '\', ?)', [newVersion])
                .then(() => trans);
        });
    }

    protected _ourVersionChecker(wipeIfExists: boolean): SyncTasks.Promise<void> {
        return this._getDbVersion()
            .then(oldVersion => {
                if (oldVersion !== this._schema.version) {
                    // Needs a schema upgrade/change
                    if (!wipeIfExists && this._schema.version < oldVersion) {
                        console.log('Database version too new (' + oldVersion + ') for schema version (' + this._schema.version + '). Wiping!');
                        wipeIfExists = true;
                    }

                    return this._changeDbVersion(oldVersion, this._schema.version).then(trans => {
                        return this._upgradeDb(trans, oldVersion, wipeIfExists);
                    });
                } else if (wipeIfExists) {
                    // No version change, but wipe anyway
                    return this.openTransaction(undefined, true).then((trans: SqlTransaction) => {
                        return this._upgradeDb(trans, oldVersion, true);
                    });
                }
            });
    }

    protected _upgradeDb(trans: SqlTransaction, oldVersion: number, wipeAnyway: boolean): SyncTasks.Promise<void> {
        // Get a list of all tables and indexes on the tables
        return this._getMetadata(trans).then(fullMeta => {
            // Get Index metadatas
            let indexMetadata: IndexMetadata[] = _.chain(fullMeta)
                .map(meta => {
                    let metaObj: IndexMetadata;
                    _.attempt(() => {
                        metaObj = JSON.parse(meta.value);
                    });
                    return metaObj;
                })
                .filter(meta => meta && !!meta.storeName)
                .value();
            return trans.runQuery('SELECT type, name, tbl_name, sql from sqlite_master', [])
                .then(rows => {
                    let tableNames: string[] = [];
                    let indexNames: { [table: string]: string[] } = {};
                    let tableSqlStatements: { [table: string]: string } = {};

                    _.each(rows, row => {
                        const tableName = row['tbl_name'];
                        // Ignore browser metadata tables for websql support
                        if (tableName === '__WebKitDatabaseInfoTable__' || tableName === 'metadata') {
                            return;
                        }
                        // Ignore FTS-generated side tables
                        const endsIn = (str, checkstr) => {
                            const i = str.indexOf(checkstr);
                            return i !== -1 && i === str.length - checkstr.length;
                        };
                        if (endsIn(tableName, '_content') || endsIn(tableName, '_segments') || endsIn(tableName, '_segdir')) {
                            return;
                        }
                        if (row['type'] === 'table') {
                            tableNames.push(row['name']);
                            if (!indexNames[row['name']]) {
                                indexNames[row['name']] = [];
                            }
                            tableSqlStatements[row['name']] = row['sql'];
                        }
                        if (row['type'] === 'index') {
                            if (row['name'].substring(0, 17) === 'sqlite_autoindex_') {
                                // auto-index, ignore
                                return;
                            }
                            if (!indexNames[tableName]) {
                                indexNames[tableName] = [];
                            }
                            indexNames[tableName].push(row['name']);
                        }
                    });

                    // Check each table!
                    let dropQueries: SyncTasks.Promise<any>[] = [];
                    if (wipeAnyway || (this._schema.lastUsableVersion && oldVersion < this._schema.lastUsableVersion)) {
                        // Clear all stores if it's past the usable version
                        if (!wipeAnyway) {
                            console.log('Old version detected (' + oldVersion + '), clearing all tables');
                        }

                        dropQueries = _.map(tableNames, name => trans.runQuery('DROP TABLE ' + name));

                        // Drop all existing metadata
                        const metaToDropArg = _.map(indexMetadata, meta => meta.key).join(', ');
                        dropQueries.push(trans.runQuery('DELETE FROM metadata where name in (?) ', [metaToDropArg]));
                        indexMetadata = [];
                        tableNames = [];
                    } else {
                        // Just delete tables we don't care about anymore. Preserve multi-entry tables, they may not be changed
                        let tableNamesNeeded: string[] = [];
                        _.each(this._schema.stores, store => {
                            tableNamesNeeded.push(store.name);
                            _.each(store.indexes, index => {
                                if (index.multiEntry) {
                                    tableNamesNeeded.push(getIndexIdentifier(store, index));
                                }
                            });
                        });
                        dropQueries = _.flatten(_.chain(tableNames)
                            .filter(name => !_.includes(tableNamesNeeded, name))
                            .map(name => {
                                const transList: SyncTasks.Promise<any>[] = [trans.runQuery('DROP TABLE ' + name)];
                                const metasToDelete = _.chain(indexMetadata)
                                    .filter(meta => meta.storeName === name)
                                    .map(meta => meta.key)
                                    .value();

                                // Clean up metas
                                if (metasToDelete.length > 0) {
                                    transList.push(trans.runQuery('DELETE FROM metadata where name in (?)', [metasToDelete.join(', ')]));
                                    indexMetadata = _.filter(indexMetadata, meta => !_.includes(metasToDelete, meta.key));
                                }
                                return transList;
                            })
                            .value());

                        tableNames = _.filter(tableNames, name => _.includes(tableNamesNeeded, name));
                    }

                    return SyncTasks.all(dropQueries).then(() => {
                        let tableQueries = [];

                        // Go over each store and see what needs changing
                        _.each(this._schema.stores, storeSchema => {
                            const indexMaker = () => {
                                let metaQueries: SyncTasks.Promise<any>[] = [];
                                const indexQueries = _.map(storeSchema.indexes, index => {
                                    const indexIdentifier = getIndexIdentifier(storeSchema, index);

                                    // Store meta for the index
                                    const newMeta: IndexMetadata = {
                                        key: indexIdentifier,
                                        storeName: storeSchema.name,
                                        index: index
                                    };
                                    metaQueries.push(this._storeIndexMetadata(trans, newMeta));
                                    // Go over each index and see if we need to create an index or a table for a multiEntry index
                                    if (index.multiEntry) {
                                        if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                                            throw new Error('Can\'t use multiEntry and compound keys');
                                        } else {
                                            return trans.runQuery('CREATE TABLE ' + indexIdentifier +
                                                ' (nsp_key TEXT, nsp_refrowid INTEGER)').then(() => {
                                                    return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' +
                                                        indexIdentifier + '_pi ON ' + indexIdentifier + ' (nsp_key, nsp_refrowid)');
                                                });
                                        }
                                    } else if (index.fullText && this._supportsFTS3) {
                                        // If FTS3 isn't supported, we'll make a normal column and use LIKE to seek over it, so the
                                        // fallback below works fine.
                                        return trans.runQuery('CREATE VIRTUAL TABLE ' + indexIdentifier +
                                            ' USING FTS3(nsp_key TEXT, nsp_refrowid INTEGER)');
                                    } else {
                                        return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' + indexIdentifier +
                                            ' ON ' + storeSchema.name + ' (nsp_i_' + index.name + ')');
                                    }
                                });

                                return SyncTasks.all(indexQueries);
                            };

                            // Form SQL statement for table creation
                            let fieldList = [];

                            fieldList.push('nsp_pk TEXT PRIMARY KEY');

                            fieldList.push('nsp_data TEXT');

                            const nonMultiIndexes = _.filter(storeSchema.indexes || [], index => !index.multiEntry);
                            const indexColumns = _.map(nonMultiIndexes, index => 'nsp_i_' + index.name + ' TEXT');
                            fieldList = fieldList.concat(indexColumns);
                            const tableMakerSql = 'CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')';

                            const tableMaker = () => {
                                // Create the table
                                return trans.runQuery(tableMakerSql)
                                    .then(indexMaker);
                            };

                            const needsMigration = () => {
                                // Check if sql used to create the base table has changed
                                if (tableSqlStatements[storeSchema.name] !== tableMakerSql) {
                                    return true;
                                }

                                // Check if indicies are missing
                                return _.some(storeSchema.indexes, index => {
                                    // Check if key paths agree
                                    const indexIdentifier = getIndexIdentifier(storeSchema, index);
                                    const indexMeta = _.find(indexMetadata, meta => meta.key === indexIdentifier);
                                    if (!indexMeta || !_.isEqual(indexMeta.index, index)) {
                                        return true;
                                    }

                                    // Check that indicies actually exist
                                    if (index.multiEntry && !_.includes(tableNames, indexIdentifier)) {
                                        return true;
                                    }

                                    if (!index.multiEntry && !_.includes(indexNames[storeSchema.name], indexIdentifier)) {
                                        return true;
                                    }
                                });
                            };

                            // If the table exists, check if we can view the sql statement used to create this table. Use it to determine
                            // if a migration is needed, otherwise just make a copy and fully migrate the data over.
                            const tableExists = _.includes(tableNames, storeSchema.name);
                            const tableRequiresMigration = tableExists && needsMigration();

                            if (tableExists && tableRequiresMigration) {
                                // Nuke old indexes on the original table (since they don't change names and we don't need them anymore)
                                let nukeIndexesAndRename = SyncTasks.all(_.map(indexNames[storeSchema.name], indexName =>
                                    trans.runQuery('DROP INDEX ' + indexName)
                                )).then(() => {
                                    // Then rename the table to a temp_[name] table so we can migrate the data out of it
                                    return trans.runQuery('ALTER TABLE ' + storeSchema.name + ' RENAME TO temp_' + storeSchema.name);
                                });

                                // Migrate the data over using our existing put functions (since it will do the right things with the indexes)
                                // and delete the temp table.
                                let migrator = () => {
                                    let store = trans.getStore(storeSchema.name);
                                    return trans.internal_getResultsFromQuery('SELECT nsp_data FROM temp_' + storeSchema.name).then(objs => {
                                        return store.put(objs).then(() => {
                                            return trans.runQuery('DROP TABLE temp_' + storeSchema.name);
                                        });
                                    });
                                };

                                tableQueries.push(nukeIndexesAndRename.then(tableMaker).then(migrator));
                            } else if (!tableExists) {
                                // Table doesn't exist -- just go ahead and create it without the migration path
                                tableQueries.push(tableMaker());
                            }
                        });

                        return SyncTasks.all(tableQueries);
                    });
                });
        }).then(_.noop);
    }
}

// The DbTransaction implementation for the WebSQL DbProvider.  All WebSQL accesses go through the transaction
// object, so this class actually has several helpers for executing SQL queries, getting results from them, etc.
export abstract class SqlTransaction implements NoSqlProvider.DbTransaction {
    private _isOpen = true;

    constructor(
            protected _schema: NoSqlProvider.DbSchema,
            protected _verbose: boolean,
            protected _maxVariables: number,
            private _supportsFTS3: boolean) {
        if (this._verbose) {
            console.log('Opening Transaction');
        }
    }

    protected _isTransactionOpen(): boolean {
        return this._isOpen;
    }

    internal_markTransactionClosed(): void {
        if (this._verbose) {
            console.log('Marking Transaction Closed');
        }
        this._isOpen = false;
    }

    abstract getCompletionPromise(): SyncTasks.Promise<void>;
    abstract abort(): void;

    abstract runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]>;

    internal_getMaxVariables(): number {
        return this._maxVariables;
    }

    internal_nonQuery(sql: string, parameters?: any[]): SyncTasks.Promise<void> {
        return this.runQuery(sql, parameters).then<void>(_.noop);
    }

    internal_getResultsFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T[]> {
        return this.runQuery(sql, parameters).then(rows => {
            let rets: T[] = [];
            for (let i = 0; i < rows.length; i++) {
                try {
                    rets.push(JSON.parse(rows[i].nsp_data));
                } catch (e) {
                    return SyncTasks.Rejected('Error parsing database entry in getResultsFromQuery: ' + JSON.stringify(rows[i].nsp_data));
                }
            }
            return rets;
        });
    }

    internal_getResultFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T> {
        return this.internal_getResultsFromQuery<T>(sql, parameters)
            .then(rets => rets.length < 1 ? undefined : rets[0]);
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        const storeSchema = _.find(this._schema.stores, store => store.name === storeName);
        if (!storeSchema) {
            return undefined;
        }

        return new SqlStore(this, storeSchema, this._requiresUnicodeReplacement(), this._supportsFTS3);
    }

    protected _requiresUnicodeReplacement(): boolean {
        return false;
    }
}

// Generic base transaction for anything that matches the syntax of a SQLTransaction interface for executing sql commands.
// Conveniently, this works for both WebSql and cordova's Sqlite plugin.
export abstract class SqliteSqlTransaction extends SqlTransaction {
    private _pendingQueries: SyncTasks.Deferred<any>[] = [];

    constructor(protected _trans: SQLTransaction, schema: NoSqlProvider.DbSchema, verbose: boolean, maxVariables: number,
            supportsFTS3: boolean) {
        super(schema, verbose, maxVariables, supportsFTS3);
    }

    // If an external provider of the transaction determines that the transaction has failed but won't report its failures
    // (i.e. in the case of WebSQL), we need a way to kick the hanging queries that they're going to fail since otherwise
    // they'll never respond.
    failAllPendingQueries(error: any) {
        const list = this._pendingQueries;
        this._pendingQueries = [];
        _.each(list, query => {
            query.reject(error);
        });
    }

    runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]> {
        if (!this._isTransactionOpen()) {
            return SyncTasks.Rejected('SqliteSqlTransaction already closed');
        }

        const deferred = SyncTasks.Defer<any[]>();
        this._pendingQueries.push(deferred);

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        const errRet = _.attempt(() => {
            this._trans.executeSql(sql, parameters, (t, rs) => {
                const index = _.indexOf(this._pendingQueries, deferred);
                if (index !== -1) {
                    let rows = [];
                    for (let  i = 0; i < rs.rows.length; i++) {
                        rows.push(rs.rows.item(i));
                    }
                    this._pendingQueries.splice(index, 1);
                    deferred.resolve(rows);
                } else {
                    console.error('SQL statement resolved twice (success this time): ' + sql);
                }
            }, (t, err) => {
                if (!err) {
                    // The cordova-native-sqlite-storage plugin only passes a single parameter here, the error, slightly breaking the interface.
                    err = t as any;
                }

                const index = _.indexOf(this._pendingQueries, deferred);
                if (index !== -1) {
                    this._pendingQueries.splice(index, 1);
                    deferred.reject(err);
                } else {
                    console.error('SQL statement resolved twice (this time with failure)');
                }

                // Causes a rollback on websql
                return true;
            });
        });

        if (errRet) {
            deferred.reject(errRet);
        }

        return deferred.promise();
    }
}

// DbStore implementation for the SQL-based DbProviders.  Implements the getters/setters against the transaction object and all of the
// glue for index/compound key support.
class SqlStore implements NoSqlProvider.DbStore {
    constructor(private _trans: SqlTransaction, private _schema: NoSqlProvider.StoreSchema, private _replaceUnicode: boolean,
            private _supportsFTS3: boolean) {
        // Empty
    }

    get<T>(key: any | any[]): SyncTasks.Promise<T> {
        let joinedKey: string;
        const err = _.attempt(() => {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._trans.internal_getResultFromQuery<T>('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
    }

    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]> {
        let joinedKeys: string[];
        const err = _.attempt(() => {
            joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        if (joinedKeys.length === 0) {
            return SyncTasks.Resolved<T[]>([]);
        }

        let qmarks = _.map(joinedKeys, k => '?');

        return this._trans.internal_getResultsFromQuery<T>('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk IN (' +
            qmarks.join(',') + ')', joinedKeys);
    }

    private static _unicodeFixer = new RegExp('[\u2028\u2029]', 'g');

    put(itemOrItems: any | any[]): SyncTasks.Promise<void> {
        let items = NoSqlProviderUtils.arrayify(itemOrItems);

        if (items.length === 0) {
            return SyncTasks.Resolved<void>();
        }

        let fields: string[] = ['nsp_pk', 'nsp_data'];
        let qmarks: string[] = ['?', '?'];
        let args: any[] = [];

        _.each(this._schema.indexes, index => {
            if (!index.multiEntry || (index.fullText && !this._supportsFTS3)) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });

        const qmarkString = qmarks.join(',');
        const err = _.attempt(() => {
            _.each(<any[]>items, (item) => {
                let serializedData = JSON.stringify(item);
                // For now, until an issue with cordova-ios is fixed (https://issues.apache.org/jira/browse/CB-9435), have to replace
                // \u2028 and 2029 with blanks because otherwise the command boundary with cordova-ios silently eats any strings with them.
                if (this._replaceUnicode) {
                    serializedData = serializedData.replace(SqlStore._unicodeFixer, '');
                }
                args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath), serializedData);

                _.each(this._schema.indexes, index => {
                    if (index.fullText && !this._supportsFTS3) {
                        args.push(FakeFTSJoinToken +
                            FullTextSearchHelpers.getFullTextIndexWordsForItem(<string> index.keyPath, item).join(FakeFTSJoinToken));
                    } else if (!index.multiEntry) {
                        args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath));
                    }
                });
            });
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }

        // Need to not use too many variables per insert, so batch the insert if needed.
        let inserts: SyncTasks.Promise<void>[] = [];
        const itemPageSize = Math.floor(this._trans.internal_getMaxVariables() / fields.length);
        for (let i = 0; i < items.length; i += itemPageSize) {
            const thisPageCount = Math.min(itemPageSize, items.length - i);
            const qmarksValues = _.fill(new Array(thisPageCount), qmarkString);
            inserts.push(this._trans.internal_nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') + ') VALUES (' +
                qmarksValues.join('),(') + ')', args.splice(0, thisPageCount * fields.length)));
        }

        return SyncTasks.all(inserts).then(() => {
            if (_.some(this._schema.indexes, index => index.multiEntry || (index.fullText && this._supportsFTS3))) {
                let queries: SyncTasks.Promise<void>[] = [];

                // Go through and do followup inserts for multientry indexes
                _.each(items, item => {
                    let key: string;
                    const err = _.attempt(() => {
                        key = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);
                    });
                    if (err) {
                        queries.push(SyncTasks.Rejected<void>(err));
                    }

                    queries.push(this._trans.runQuery('SELECT rowid a FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [key]).then(rets => {
                        let rowid = rets[0].a;

                        let inserts: SyncTasks.Promise<void>[] = [];
                        _.each(this._schema.indexes, index => {
                            let serializedKeys: string[];

                            if (index.fullText && this._supportsFTS3) {
                                // FTS3 terms go in a separate virtual table...
                                serializedKeys = [FullTextSearchHelpers.getFullTextIndexWordsForItem(<string> index.keyPath, item).join(' ')];
                            } else if (index.multiEntry) {
                                // Have to extract the multiple entries into the alternate table...
                                const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>index.keyPath);
                                if (valsRaw) {
                                    const err = _.attempt(() => {
                                        serializedKeys = _.map(NoSqlProviderUtils.arrayify(valsRaw), val =>
                                            NoSqlProviderUtils.serializeKeyToString(val, <string>index.keyPath));
                                    });
                                    if (err) {
                                        inserts.push(SyncTasks.Rejected<void>(err));
                                        return;
                                    }
                                }
                            } else {
                                return;
                            }

                            let valArgs = [], args = [];
                            _.each(serializedKeys, val => {
                                valArgs.push('(?, ?)');
                                args.push(val);
                                args.push(rowid);
                            });
                            inserts.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                                    ' WHERE nsp_refrowid = ?', [rowid]).then(() => {
                                if (valArgs.length > 0){
                                    return this._trans.internal_nonQuery('INSERT INTO ' + this._schema.name + '_' + index.name +
                                        ' (nsp_key, nsp_refrowid) VALUES ' + valArgs.join(','), args);
                                }
                            }));
                        });
                        return SyncTasks.all(inserts).then(_.noop);
                    }));
                });

                return SyncTasks.all(queries).then(_.noop);
            }
        });
    }

    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void> {
        let joinedKeys: string[];
        const err = _.attempt(() => {
            joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }

        // PERF: This is optimizable, but it's of questionable utility
        const queries = _.map(joinedKeys, joinedKey => {
            if (_.some(this._schema.indexes, index => index.multiEntry)) {
                // If there's any multientry indexes, we have to do the more complicated version...
                return this._trans.runQuery('SELECT rowid a FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]).then(rets => {
                    if (rets.length === 0) {
                        return undefined;
                    }

                    let queries = _.chain(this._schema.indexes).filter(index => index.multiEntry).map(index =>
                        this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                            ' WHERE nsp_refrowid = ?', [rets[0].a])).value();
                    queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + ' WHERE rowid = ?', [rets[0].a]));
                    return SyncTasks.all(queries).then(_.noop);
                });
            }

            return this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
        });

        return SyncTasks.all(queries).then(_.noop);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        const indexSchema = _.find(this._schema.indexes, index => index.name === indexName);
        if (!indexSchema) {
            return undefined;
        }

        return new SqlStoreIndex(this._trans, this._schema, indexSchema, this._supportsFTS3);
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new SqlStoreIndex(this._trans, this._schema, undefined, this._supportsFTS3);
    }

    clearAllData(): SyncTasks.Promise<void> {
        let queries = _.chain(this._schema.indexes).filter(index => index.multiEntry).map(index =>
            this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name)).value();

        queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name));

        return SyncTasks.all(queries).then(_.noop);
    }
}

// DbIndex implementation for SQL-based DbProviders.  Wraps all of the nasty compound key logic and general index traversal logic into
// the appropriate SQL queries.
class SqlStoreIndex implements NoSqlProvider.DbIndex {
    private _queryColumn: string;
    private _tableName: string;
    private _rawTableName: string;
    private _indexTableName: string;
    private _keyPath: string | string[];

    constructor(protected _trans: SqlTransaction, storeSchema: NoSqlProvider.StoreSchema, indexSchema: NoSqlProvider.IndexSchema,
            private _supportsFTS3: boolean) {
        if (!indexSchema) {
            // Going against the PK of the store
            this._tableName = storeSchema.name;
            this._rawTableName = this._tableName;
            this._indexTableName = this._tableName;
            this._queryColumn = 'nsp_pk';
            this._keyPath = storeSchema.primaryKeyPath;
        } else {
            if (indexSchema.multiEntry || (indexSchema.fullText && this._supportsFTS3)) {
                this._tableName = storeSchema.name + '_' + indexSchema.name + ' mi LEFT JOIN ' + storeSchema.name +
                ' ON mi.nsp_refrowid = ' + storeSchema.name + '.rowid';
                this._rawTableName = storeSchema.name;
                this._indexTableName = storeSchema.name + '_' + indexSchema.name;
                this._queryColumn = 'mi.nsp_key';
            } else {
                this._tableName = storeSchema.name;
                this._rawTableName = this._tableName;
                this._indexTableName = this._tableName;
                this._queryColumn = 'nsp_i_' + indexSchema.name;
            }
            this._keyPath = indexSchema.keyPath;
        }
    }

    private _handleQuery<T>(sql: string, args: any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        sql += ' ORDER BY ' + this._queryColumn + (reverse ? ' DESC' : ' ASC');

        if (limit) {
            sql += ' LIMIT ' + limit.toString();
        }
        if (offset) {
            sql += ' OFFSET ' + offset.toString();
        }

        return this._trans.internal_getResultsFromQuery<T>(sql, args);
    }

    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName, undefined, reverse, limit, offset);
    }

    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        let joinedKey: string;
        const err = _.attempt(() => {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' = ?', [joinedKey],
            reverse, limit, offset);
    }

    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        let checks: string;
        let args: string[];
        const err = _.attempt(() => {
            const ret = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks, args, reverse, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getRangeChecks(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean) {
        let checks: string[] = [];
        let args: string[] = [];
        if (keyLowRange !== null && keyLowRange !== undefined) {
            checks.push(this._queryColumn + (lowRangeExclusive ? ' > ' : ' >= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath));
        }
        if (keyHighRange !== null && keyHighRange !== undefined) {
            checks.push(this._queryColumn + (highRangeExclusive ? ' < ' : ' <= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath));
        }
        return { checks: checks.join(' AND '), args };
    }

    countAll(): SyncTasks.Promise<number> {
        return this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName).then(result => result[0]['cnt']);
    }

    countOnly(key: any|any[]): SyncTasks.Promise<number> {
        let joinedKey: string;
        const err = _.attempt(() => {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + this._queryColumn
            + ' = ?', [joinedKey]).then(result => result[0]['cnt']);
    }

    countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        let checks: string;
        let args: string[];
        const err = _.attempt(() => {
            const ret = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + checks, args)
            .then(result => result[0]['cnt']);
    }

    fullTextSearch<T>(searchPhrase: string, resolution: NoSqlProvider.FullTextTermResolution = NoSqlProvider.FullTextTermResolution.And, limit?: number)
            : SyncTasks.Promise<T[]> {
        const terms = FullTextSearchHelpers.breakAndNormalizeSearchPhrase(searchPhrase);

        if (this._supportsFTS3) {
            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' MATCH ?',
                    [_.map(terms, term => term + '*').join(' ')], false, limit);
            } else if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                // SQLite FTS3 doesn't support OR queries so we have to hack it...
                const baseQueries = _.map(terms, term => 'SELECT * FROM ' + this._indexTableName + ' WHERE nsp_key MATCH ?');
                const joinedQuery = 'SELECT * FROM (SELECT DISTINCT * FROM (' + baseQueries.join(' UNION ALL ') + ')) mi LEFT JOIN ' +
                    this._rawTableName + ' t ON mi.nsp_refrowid = t.rowid';
                const args = _.map(terms, term => term + '*');
                return this._handleQuery<T>(joinedQuery, args, false, limit);
            } else {
                return SyncTasks.Rejected<T[]>('fullTextSearch called with invalid term resolution mode');
            }
        } else {
            let joinTerm: string;
            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                joinTerm = ' AND ';
            } else if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                joinTerm = ' OR ';
            } else {
                return SyncTasks.Rejected<T[]>('fullTextSearch called with invalid term resolution mode');
            }

            return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' +
                _.map(terms, term => this._queryColumn + ' LIKE ?').join(joinTerm),
                _.map(terms, term => '%' + FakeFTSJoinToken + term + '%'));
        }
    }
}
