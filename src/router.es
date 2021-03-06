import Router from 'koa-router'
import compose from 'koa-compose'
import Model from './model'
import Collection from 'bookshelf/lib/collection'
import paginate from 'koa-pagination'
import convert from 'koa-convert'
import joi_to_json_schema from 'joi-to-json-schema'
import jsf from 'json-schema-faker'
import Joi from 'joi'
import _ from 'lodash'
import pluralize from 'pluralize'

Router.define = function (options) {
  let {setup, ...rest} = options;
  if (_.isFunction(options)) {
    setup = options;
    options = {};
  }
  options = rest || options;
  setup = setup || (router => router)
  let router = new Router(options);
  setup(router);

  return router;
}

Router.prototype.schema = function () {
  return null;
}

export function schema(request, response) {
  let request_schema = request ? joi_to_json_schema(request) : {};
  let response_schema = response ? joi_to_json_schema(response) : {};
  return {
    schema:{
      request: request_schema,
      response: response_schema
    },
    example:{
      request: !_.isEmpty(request_schema) ? jsf(request_schema) : {},
      response: !_.isEmpty(response_schema) ? jsf(response_schema) : {}
    }
  }
}

function parse_args(ori_args, option_defaults = {}) {
  let args = Array.prototype.slice.call(ori_args);
  let none = async (ctx, next) => await next();
  let options = args.pop();
  let middlewares = args;
  middlewares = _.compact(middlewares);
  if (_.isFunction(options)) {
    middlewares = middlewares.concat(options);
    options = {};
  }
  middlewares = _.isEmpty(middlewares) ? [none] : middlewares ;
  options = _.defaults(options, option_defaults);

  return {middlewares, options};
}


export class ResourceRouter extends Router {
  methods = {create:false, read:false, update: false, destroy: false}

  static define(options){
    let {collection, setup, ...rest} = options;
    if (options instanceof Function || options instanceof Collection) {
      collection = options;
      options = undefined;
    }
    options = rest || options;
    setup = setup || (router => router.crud())
    let router = new this(collection, options);
    setup(router);
    return router;
  }
  constructor(collection, options){
    options = _.defaults(options, {
      root: '',
      id: '',
      name: '',
    });
    super(options);
    this.collection = collection;
    if (!_.isFunction(collection)) {
      options.model= options.model || collection.model;
      options.id   = options.id || options.model.prototype.idAttribute;
      options.idType = '\\d+'
      this.collection = ctx => collection;
    }
    options.name = options.name || options.model.prototype.tableName;
    options.singular_name = pluralize.singular(options.name)
    options.foreignId = `${options.singular_name}_id`
    options.fields = options.fields || (options.model ? options.model.fields : undefined);
    options.root = options.root || '/' + options.name;
    options.title = options.title || options.name;
    options.description = options.description || options.title;
    options.id = options.id || 'id';
    this.options = options;

    this.pattern = {
      root: options.root || '/',
      item: (options.root ? options.root : '') + '/:' + options.id
    }
  }

  schema(){
    let { options:{ model, fields, id, title, description } } = this;
    if (!fields) {
      throw new Error('fields can not be empty');
    }
    let f = fields.isJoi ? fields._inner.children.reduce((_tmp, v)=>{
      _tmp[v.key] = v.schema;
      return _tmp;
    }, {}) : fields;

    let base_joi = Object.assign({
      [id]: Joi.any(),
    }, model.prototype.hasTimestamps ? {
      created_at: Joi.date(),
      updated_at: Joi.date()
    } : {});

    let request_item = Joi.object(_.omit(f, _.keys(base_joi))).label(title).description(description);
    let response_item = Joi.object(Object.assign({}, base_joi, _.mapValues(f, v => v.required()))).label(title).description(description);
    let result = {};
    _.forIn(this.methods, (v, k) => {
      if (v) {
        let s;
        switch (k) {
          case 'create':
            s = schema(request_item, response_item);
          break;
          case 'read':
            result['list'] = schema(null, Joi.array().items(response_item));
            result['read'] = schema(null, response_item);
          break;
          case 'update':
            let req = Joi.object(_.omit(_.mapValues(f, v => v.optional()), _.keys(base_joi))).label(title).description(description);
            s = schema(req, response_item);
            break;
          case 'destroy':
            s = schema(null, null);
          break;
        }
        if (s) {
          result[k] = s;
        }
      }
    });

    return result;
  }

  create(){
    let {middlewares, options} = parse_args(arguments)
    let {collection, options:{id}, pattern} = this;
    this.methods.create = true;
    // create
    this.post(pattern.root, compose(middlewares), async (ctx) => {
      let attributes = ctx.state.attributes || ctx.request.body;
      if (collection(ctx).relatedData) {
        ctx.state.resource = await collection(ctx).create(attributes);
      } else {
        ctx.state.resource = collection(ctx).model.forge();
        await ctx.state.resource.save(attributes, Object.assign({}, options.save || {}));
      }
      ctx.body = ctx.state.resource;
      ctx.status = 201;
    });
    return this;
  }
  read(){
    let {middlewares, options} = parse_args(arguments, {
      joins: [],
      sortable: [],
      searchable: [],
      filterable: [],
      pagination:undefined,
      fetch: {},
      fetchItem: {},
    });
    let {collection, options:{id}, pattern} = this;
    this.methods.read = true;
    // read list
    this.get(pattern.root,
             convert(paginate(options.pagination)),
             compose(middlewares),
             async (ctx) => {
               let query = ctx.state.query || collection(ctx).model.forge();
               if (collection(ctx).relatedData) {
                 query = query.where({[collection(ctx).relatedData.key('foreignKey')]:collection(ctx).relatedData.parentId})
               }
               if (options.joins) {
                 options.joins.forEach(relation => query.join(relation));
               }
               if (options.sortable) {
                 let order_by = _.get(ctx, 'request.query.sort', _.first(options.sortable));
                 if (_.includes(options.sortable, _.trimStart(order_by, '-'))) {
                   query = query.orderBy(order_by, order_by[0] == '-' ? 'DESC' : 'ASC');
                 }
               }
               if (options.filterable) {
                 let filters = options.filterable.map(filter => {
                   return _.isString(filter) ? (query, filters) => {
                     if (filters[filter] === undefined) {
                       return query;
                     }
                     return query.query(qb => {
                       if (_.isArray(filters[filter])) {
                         return qb.whereIn(filter, filters[filter]);
                       } else {
                         return qb.where(filter, '=', filters[filter]);
                       }
                     });
                   } : filter;
                 });
                 filters.forEach(filter => {
                   try {
                     let _filters = ctx.request.query.filters || {}
                     if (_.isString(_filters)) {
                       _filters = JSON.parse(_filters)
                     }
                     query = filter(query, _filters);
                   } catch (e) {}
                 });
               }
               if (options.searchable) {
                 let keywords = _.get(ctx, 'request.query.q');
                 if (keywords) {
                   query = query.query(q => {
                     q = q.where(function(){
                       options.searchable.forEach((field, index) => {
                         this[index ? 'orWhere' : 'where'](field, 'LIKE', '%' + keywords + '%');
                       });
                     });

                     return q;
                   });
                 }
               }
               let resources = await query.fetchPage(Object.assign({}, ctx.pagination, options.fetch));

               ctx.body = resources.models;
               ctx.pagination.length = resources.pagination.rowCount;
             });

    // read item
    this.get(pattern.item, compose(middlewares) || none, async (ctx) => {
      ctx.body = await collection(ctx)
      .query(q => q.where({[id]:ctx.params[id]}))
      .fetchOne(Object.assign({
        required: true,
      }, options.fetchItem));
    });


    return this;
  }
  update(){
    let {middlewares, options} = parse_args(arguments);
    let {collection, options:{id}, pattern} = this;
    this.methods.update = true;
    const update = async (ctx) => {
      let attributes = ctx.state.attributes || ctx.request.body;
      ctx.state.resource = (await collection(ctx).query(q => q.where({[id]:ctx.params[id]})).fetch({required:true})).first();
      await ctx.state.resource.save(attributes, Object.assign({ patch: true }, options.save || {}));
      if (options.after)  await options.after(ctx);
      ctx.body = ctx.state.resource;
      ctx.status = 202;
    }
    this.put(pattern.item, compose(middlewares), update);
    this.patch(pattern.item, compose(middlewares), update);

    return this;
  }
  destroy(){
    let {middlewares, options} = parse_args(arguments)
    let {collection, pattern, options:{id}} = this;
    this.methods.destroy = true;

    this.del(pattern.item, compose(middlewares), async (ctx) => {
      ctx.state.resource = await collection(ctx).query(q => q.where({[id]:ctx.params[id]})).fetchOne({require:true});
      ctx.state.deleted  = ctx.state.resource.toJSON();

      await ctx.state.resource.destroy(Object.assign({}, options.destroy || {}));
      if (options.after) await options.after(ctx);
      ctx.status = 204;
    });
    return this;
  }
  crud(){
    return this.create().read().update().destroy();
  }
  children(){
    const { foreignId, idType, singular_name } = this.options
    const children = Array.slice(arguments)
    this.use.apply(this, [
      `${this.pattern.root}/:${foreignId}(${idType})`,
      async(ctx, next) => {
        ctx.state.children = ctx.state.children || {}
        ctx.state.children[singular_name] = await this.collection(ctx)
        .query(q => q.where({[this.options.id]:ctx.params[foreignId]}))
        .fetchOne({required: true})
        await next()
      },
      ...children.map(child => child.routes())
    ])
    return this
  }
}

export {Router};
