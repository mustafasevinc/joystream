// Copyright 2017-2019 @polkadot/app-addresses authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { AppProps, I18nProps } from '@polkadot/ui-app/types';
import { SubjectInfo } from '@polkadot/ui-keyring/observable/types';
import { ComponentProps } from './types';

import './index.css';

import React from 'react';
import { Route, Switch } from 'react-router';
import addressObservable from '@polkadot/ui-keyring/observable/addresses';
import Tabs, { TabItem } from '@polkadot/ui-app/Tabs';
import { withMulti, withObservable } from '@polkadot/ui-api';

import Creator from './Creator';
import Editor from './Editor';
import MemoByAccount from './MemoByAccount';
import translate from './translate';

type Props = AppProps & I18nProps & {
  allAddresses?: SubjectInfo
};

type State = {
  hidden: Array<string>,
  items: Array<TabItem>
};

class AddressesApp extends React.PureComponent<Props, State> {
  state: State;

  constructor (props: Props) {
    super(props);

    const { allAddresses = {}, t } = props;
    const baseState = Object.keys(allAddresses).length !== 0
      ? AddressesApp.showEditState()
      : AddressesApp.hideEditState();

    this.state = {
      ...baseState,
      items: [
        {
          name: 'edit',
          text: t('Edit address')
        },
        {
          name: 'create',
          text: t('Add address')
        },
        {
          name: 'memo',
          text: t('View memo')
        }
      ]
    };
  }

  static showEditState () {
    return {
      hidden: []
    };
  }

  static hideEditState () {
    return {
      hidden: ['edit']
    };
  }

  static getDerivedStateFromProps ({ allAddresses = {} }: Props, { hidden }: State) {
    const hasAddresses = Object.keys(allAddresses).length !== 0;

    if (hidden.length === 0) {
      return hasAddresses
        ? null
        : AddressesApp.hideEditState();
    }

    return hasAddresses
      ? AddressesApp.showEditState()
      : null;
  }

  render () {
    const { basePath } = this.props;
    const { hidden, items } = this.state;
    const renderCreator = this.renderComponent(Creator);

    return (
      <main className='addresses--App'>
        <header>
          <Tabs
            basePath={basePath}
            hidden={hidden}
            items={items}
          />
        </header>
        <Switch>
          <Route path={`${basePath}/create`} render={renderCreator} />
          <Route path={`${basePath}/memo/:accountId?`} component={MemoByAccount} />
          <Route
            render={
              hidden.includes('edit')
                ? renderCreator
                : this.renderComponent(Editor)
            }
          />
        </Switch>
      </main>
    );
  }

  private renderComponent (Component: React.ComponentType<ComponentProps>) {
    return () => {
      const { basePath, location, onStatusChange } = this.props;

      return (
        <Component
          basePath={basePath}
          location={location}
          onStatusChange={onStatusChange}
        />
      );
    };
  }
}

export default withMulti(
  AddressesApp,
  translate,
  withObservable(addressObservable.subject, { propName: 'allAddresses' })
);
